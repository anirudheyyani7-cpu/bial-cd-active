"""Projects HTTP endpoints — user-scoped CRUD for the parent container (R1, R3, R5–R7).

A project is the home a citizen developer builds one tool inside (KD-4). Identity is always
the authenticated caller; every query is scoped by `user_id` (a dropped predicate is a
cross-user leak — a cross-user id is a 404, never a leak, ADR-0004). List is keyset-paginated
+ searchable (KD-1); delete cascades through the blob-aware, rollback-safe U6 service (KD-3).

Errors use the ported `{"error": {"message": ...}}` shape (`AppApiError`), documented with
the shared `error_responses(...)` + `AUTH_401` builders (KD-7).
"""

from __future__ import annotations

import asyncio
import enum
import math
import uuid
from typing import Annotated

import sqlalchemy as sa
import structlog
from fastapi import APIRouter, Depends, status
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm.exc import StaleDataError

from src.api.deps import CurrentUser, DbSession
from src.api.v1.attachments.router import storage_dependency
from src.api.v1.build_sessions.deps import OptionalSandbox, SessionManagerDep
from src.api.v1.conversations._shared import ModelDep
from src.api.v1.live_build import refuse_while_build_session_live
from src.api.v1.offset_pagination import PageQuery, clean_page
from src.api.v1.pagination import (
    DEFAULT_PAGE_SIZE,
    LimitQuery,
    SearchQuery,
    clean_limit,
    clean_search,
)
from src.config import settings
from src.core.alarms import TEARDOWN_ARTEFACT_SURVIVED_EVENT
from src.core.errors import AppApiError
from src.db.models.app_registry import AppRegistry, AppStatus
from src.db.models.conversation import Conversation
from src.db.models.deleted_project import DeletedProject
from src.db.models.project import Project
from src.schemas import (
    AUTH_401,
    DailyTokenLimitBody,
    ErrorEnvelope,
    OkResponse,
    ProjectCountsResponse,
    ProjectCreate,
    ProjectDeleteRequest,
    ProjectListResponse,
    ProjectPatch,
    ProjectResponse,
    error_responses,
)
from src.services.appdb.provision import ensure_project_database
from src.services.appdb.teardown import salt_the_earth, teardown_handles
from src.services.audit.log import append_audit
from src.services.audit.teardown import record_what_survived
from src.services.build_sessions import SessionManager, app_name_for, read_registry, reap_user
from src.services.build_sessions.manager import restorable_presence
from src.services.deploy.liveness import live_app_ids
from src.services.deploy.registry_delete import sweep_app_repositories
from src.services.deploy.teardown import sweep_published_apps
from src.services.projects import (
    delete_project_cascade,
    extract_source,
    generate_project_description,
    owned_project_or_404,
    resweep_submission_prefixes,
)
from src.services.ratelimit import InProcessRateLimiter, RateLimitExceededError
from src.services.redis import get_redis
from src.services.redis.keys import REGISTRY_FIELD_APP_NAME
from src.services.sandbox import SandboxClient
from src.services.storage import (
    AppContainerStore,
    ObjectStorage,
    get_app_container_store,
    sweep_app_containers,
    sweep_blobs,
)
from src.services.usage.gate import DailyTokenLimitExceededError, enforce_daily_limit

logger = structlog.get_logger()

router = APIRouter(prefix="/projects", tags=["projects"])

# A project-owned storage handle for the cascade blob sweep (swappable in tests).
StorageDep = Annotated[ObjectStorage, Depends(storage_dependency)]


def container_store_dependency() -> AppContainerStore | None:
    """The per-app container store for the cascade container sweep, or `None` when object storage
    is unconfigured (dev/test). Deliberately NOT mirroring `storage_dependency` (which raises via
    `get_storage()`): the sweep is None-tolerant so a delete still succeeds with storage off
    (KTD-2); in prod `_require_storage_in_production` guarantees a store. A dependency (not a bare
    call) so tests swap a fake via `dependency_overrides`."""
    return get_app_container_store()


# `| None`-tolerant, unlike StorageDep — the container sweep no-ops when storage is disabled.
ContainerStoreDep = Annotated[AppContainerStore | None, Depends(container_store_dependency)]


def _to_response(
    project: Project,
    app_id: uuid.UUID | None = None,
    app_status: AppStatus | None = None,
    has_relaunchable_snapshot: bool | None = None,
    *,
    is_serving: bool,
) -> ProjectResponse:
    """Project a row onto the wire shape.

    `is_serving` IS REQUIRED, AND KEYWORD-ONLY, because a default here is a silent wrong
    answer. It shipped as `= False` and three of the five call sites simply never passed it,
    so `GET /{id}` reported a live app as not serving while its own field docstring says it
    IS the server's answer. A default is what let the omission type-check; without one, a new
    endpoint cannot forget it, and `_serving_now` is the one way to work it out.
    """
    return ProjectResponse(
        id=project.id,
        name=project.name,
        description=project.description,
        app_id=str(app_id) if app_id is not None else None,
        app_status=app_status.value if app_status is not None else None,
        has_relaunchable_snapshot=has_relaunchable_snapshot,
        is_serving=is_serving,
        created_at=project.created_at,
        updated_at=project.updated_at,
    )


async def _project_app(
    db: DbSession, user_id: uuid.UUID, project_id: uuid.UUID
) -> tuple[uuid.UUID | None, AppStatus | None]:
    """The project's ONE app's (id, status) — read-only discovery for the response
    (one app per project, KD-4) — or (None, None) for a fresh project. Owner-scoped
    like every query (ADR-0004)."""
    row = (
        await db.execute(
            sa.select(AppRegistry.id, AppRegistry.status).where(
                AppRegistry.project_id == project_id, AppRegistry.user_id == user_id
            )
        )
    ).one_or_none()
    return (row.id, row.status) if row is not None else (None, None)


async def _serving_now(db: DbSession, app_id: uuid.UUID | None) -> bool:
    """Is this ONE app live right now?

    The single-row form of the list's collapse, reading the SAME `live_app_ids` definition
    rather than re-deriving it — the drift `liveness.py` exists to prevent is not only
    between surfaces, it is between the list and the detail view of the same project.

    `None` means the project has no app at all, which is a confirmed False rather than an
    unknown: nothing can be serving.
    """
    if app_id is None:
        return False
    live = live_app_ids().subquery()
    return bool(await db.scalar(sa.select(sa.exists().where(live.c.app_id == app_id))))


@router.post("", status_code=status.HTTP_201_CREATED, responses=error_responses(AUTH_401))
async def create_project(body: ProjectCreate, user: CurrentUser, db: DbSession) -> ProjectResponse:
    """Create a project owned by the caller, then provision its own database (ADR-0028).

    `name` is stripped/bounded and an empty/whitespace `description` is normalized to NULL
    at the schema boundary (KD-8).

    The provision runs AFTER the commit and is BEST-EFFORT, both deliberately.
    After, because `ensure_project_database` commits its own claim and its own terminal
    marker — running it first would commit this request's half-built transaction.
    Best-effort, because a substrate hiccup must never strand or 500 a project the user
    already owns: the response is a normal 201 and the next build's lazy ensure
    (`provision_app_database`) re-runs the idempotent sequence.

    The app row is NOT minted here — it stays lazily created at first build, so a fresh
    project still reports `appId: null` (`test_app_discovery_null_for_fresh_project…`).
    """
    project = Project(user_id=user.id, name=body.name, description=body.description)
    db.add(project)
    await db.flush()
    await db.refresh(project)  # load server defaults (id, timestamps) before projecting
    project_id = project.id  # a plain scalar for the post-commit work (no expired-attribute I/O)
    await db.commit()
    # A project one statement old owns no app, so nothing of its can be serving. Passed
    # explicitly rather than defaulted: this is an answer, not an omission.
    response = _to_response(project, is_serving=False)
    await _provision_database_or_shrug(db, project_id)
    return response


async def _provision_database_or_shrug(db: DbSession, project_id: uuid.UUID) -> None:
    """Provision the project's database; on failure log and carry on (never 500).

    Resolved lazily INSIDE the body rather than through a `Depends`, so an unconfigured or
    unreachable substrate can never turn create-project into a dependency-solve 500
    (commit 6be7a9c closed exactly that class of bug).

    Only the exception TYPE is logged, never its message: a failing `CREATE ROLE` surfaces
    as a SQLAlchemy `DBAPIError` whose string carries the offending `[SQL: ...]` — which
    for that one statement contains the role's password literal.
    """
    try:
        await ensure_project_database(db, project_id)
    except Exception as exc:  # noqa: BLE001 — degraded state, not a failed create (R4)
        logger.warning(
            "project_database_provision_failed",
            project_id=str(project_id),
            error_type=type(exc).__name__,
            hint="the next build start re-runs the idempotent provision",
        )


@router.get(
    "",
    responses=error_responses(
        AUTH_401, (422, ErrorEnvelope, "Invalid page/pageSize or over-long q")
    ),
)
async def list_projects(
    user: CurrentUser,
    db: DbSession,
    page: PageQuery = 1,
    limit: LimitQuery = DEFAULT_PAGE_SIZE,
    q: SearchQuery = None,
) -> ProjectListResponse:
    """One NUMBERED page of the caller's projects, newest-first, optionally filtered by a
    case-insensitive name/description substring (R6).

    IT PAGES BY OFFSET, and `pagination.py` says the platform does not. #158 §2 specifies
    numbered pages and a rows-per-page selector — `Showing 1-8 of 12`, `Page 1 of 2` — and
    neither is expressible without a `total`, which keyset deliberately does not provide.

    THE MARKETPLACE'S ARGUMENT DOES NOT TRANSFER, and reaching for it would be the quiet
    kind of wrong. That one reads: "KD-1's keyset rule protects a list you are writing to,
    this catalog is read-only and small". This list is written to — `create` and `delete`
    both act on it, and under `ORDER BY id DESC` a new project lands at position 0, which is
    the worst case for OFFSET rather than a benign one.

    What makes it acceptable here is different and narrower: the list is OWNER-SCOPED and
    effectively SINGLE-WRITER. Every row is `WHERE user_id = :me`, and the only person who
    inserts or deletes rows in it is the person reading it. So the skew KD-1 guards against
    — a busy shared table shifting under a stranger's page walk — is here a citizen with two
    tabs open, creating a project in one while paging in the other. That is a real window
    and it is bounded by one person's own actions, which is a different risk from the one
    the rule was written for.

    `total` is a SEPARATE READ from the page under READ COMMITTED, not one snapshot, so a
    create landing between them can make the count and the rows disagree for one render.
    The client is expected to say something true when they do, rather than assert either
    number over the other.

    A page past the end returns an empty `items` with the real `total`, not a 404: paging
    past the end while a project is deleted elsewhere is ordinary, not an error.
    """
    page = clean_page(page)
    search = clean_search(q)
    limit = clean_limit(limit)
    # LEFT-JOIN the project's ONE app (uq_app_registry_project) so the page carries the
    # read-only appId/appStatus discovery without an N+1; the outer join keeps app-less
    # projects, and the app side carries its own owner scope (ADR-0004).
    # ONE JOIN, not one request per row. The status column needs to know whether each app is
    # SERVING, and "live = deployed / published, with a url" is a deployment fact rather than
    # a lifecycle one (#158). `PublishStatusChip` gets it from `getDeployment(projectId)`,
    # which is fine for one project page and is an N-way fan-out on a list — so the list
    # reads the same definition set-wise instead, via the shared `live_app_ids` collapse.
    # SCOPED to this owner, and the scoping happens INSIDE the collapse (round-4 fix): an
    # unscoped `live_app_ids()` filtered afterward by `user.id` still evaluates the
    # `DISTINCT ON` over every deployment row the PLATFORM has, because the join here cannot
    # tell the collapse to narrow first. Measured at 25,245 apps / 112,045 deployments as a
    # >300x cost on the first screen after sign-in — see `live_app_ids`'s docstring.
    live = live_app_ids(owner_user_id=user.id).subquery()
    query = (
        sa.select(Project, AppRegistry.id, AppRegistry.status, live.c.app_id.is_not(None))
        .outerjoin(
            AppRegistry,
            sa.and_(AppRegistry.project_id == Project.id, AppRegistry.user_id == user.id),
        )
        # OUTER on the liveness side too: a project with no app, or an app that has never
        # deployed, has no row here and is simply not live — it must still be listed.
        .outerjoin(live, live.c.app_id == AppRegistry.id)
        .where(Project.user_id == user.id)
    )
    if search is not None:
        query = query.where(
            sa.or_(
                Project.name.icontains(search, autoescape=True),
                Project.description.icontains(search, autoescape=True),
            )
        )
    # THE COUNT DOES NOT NEED EITHER JOIN, and carrying them was the other half of the same
    # cost: neither can change how many rows match. `AppRegistry.project_id` is unique
    # (`uq_app_registry_project`, KD-4 — one app per project), and `live.c.app_id` is unique
    # per collapse, so a project row survives an outer join to either exactly once. The count
    # runs over the SAME predicate as the page (owner + search), just without the columns
    # that predicate does not need — a total computed over a different predicate is the
    # failure that would render page numbers the user can click and find empty; a total
    # computed over a WIDER one just to reuse a query object is a cost with no such payoff.
    count_query = sa.select(Project).where(Project.user_id == user.id)
    if search is not None:
        count_query = count_query.where(
            sa.or_(
                Project.name.icontains(search, autoescape=True),
                Project.description.icontains(search, autoescape=True),
            )
        )
    count_stmt = sa.select(sa.func.count()).select_from(count_query.subquery())
    total = int(await db.scalar(count_stmt) or 0)
    rows = (
        await db.execute(query.order_by(Project.id.desc()).limit(limit).offset((page - 1) * limit))
    ).all()
    return ProjectListResponse(
        items=[
            _to_response(project, app_id, app_status, is_serving=is_serving)
            for project, app_id, app_status, is_serving in rows
        ],
        page=page,
        page_size=limit,
        total=total,
        total_pages=math.ceil(total / limit) if total else 0,
    )


@router.get("/counts", responses=error_responses(AUTH_401))
async def project_counts(user: CurrentUser, db: DbSession) -> ProjectCountsResponse:
    """The three numbers above the project list (#158 §1).

    DECLARED BEFORE `/{project_id}`, and that ordering is load-bearing: FastAPI matches in
    declaration order, so a `/counts` registered after the parameterised route would be
    swallowed by it and answer 422 on a UUID parse instead.

    Owner-scoped like every route here (ADR-0004) — these are the citizen's own projects,
    unlike `/admin/apps/counts`, which counts across owners.

    Three aggregates over one owner's rows, no row projection and no per-app probing. The
    liveness half reads the SHARED `live_app_ids` collapse, which is the whole reason this
    is not three ad-hoc queries: the list's status column reads the same definition, so
    "3 in production" above a list showing two live apps is not expressible.
    """
    # SCOPED to this owner inside the collapse — see `live_app_ids`'s docstring and
    # `list_projects`'s identical fix; this route had the same unscoped-collapse cost.
    live = live_app_ids(owner_user_id=user.id).subquery()

    # PROJECTS, not `app_registry` rows. The product calls a project an application — the
    # page is headed "Your apps" and its subtitle reads "each project is one tool" — and a
    # project exists before anything is built inside it. Counting app rows put "Total
    # applications 0" above a list showing 18 projects, which reads as broken rather than as
    # a subtle distinction, and the mockup shows the two numbers agreeing for that reason.
    total = sa.select(sa.func.count()).select_from(Project).where(Project.user_id == user.id)
    in_production = (
        sa.select(sa.func.count())
        .select_from(AppRegistry)
        .join(live, live.c.app_id == AppRegistry.id)
        .where(AppRegistry.user_id == user.id)
    )
    # In the pipeline: submitted or decided, but not yet serving. PENDING and REJECTED are
    # unambiguous. APPROVED belongs here only while it is NOT live — an approved app that is
    # serving is counted by `in_production`, and counting it twice would make the three
    # numbers sum to more than the citizen has.
    in_pipeline = (
        sa.select(sa.func.count())
        .select_from(AppRegistry)
        .outerjoin(live, live.c.app_id == AppRegistry.id)
        .where(
            AppRegistry.user_id == user.id,
            AppRegistry.status.in_((AppStatus.PENDING, AppStatus.REJECTED, AppStatus.APPROVED)),
            live.c.app_id.is_(None),
        )
    )
    return ProjectCountsResponse(
        in_production=(await db.execute(in_production)).scalar_one(),
        total_applications=(await db.execute(total)).scalar_one(),
        in_pipeline=(await db.execute(in_pipeline)).scalar_one(),
    )


@router.get(
    "/{project_id}",
    responses=error_responses(AUTH_401, (404, ErrorEnvelope, "Project not found")),
)
async def get_project(project_id: uuid.UUID, user: CurrentUser, db: DbSession) -> ProjectResponse:
    project = await owned_project_or_404(db, user.id, project_id)
    app_id, app_status = await _project_app(db, user.id, project.id)
    # N7 — the ONE surface that offers Relaunch, so the one that pays for the head-check.
    # No app row means no bundle can exist, and that is a CONFIRMED absent rather than an
    # unknown: skipping the store call here is an answer, not an omission.
    #
    # `restorable_presence`, NOT `snapshot_presence` (R18): the saved bundle alone missed the
    # builder who worked for an hour and never pressed Save, and told them their project had
    # nothing to restore while the platform sat on their entire workspace. This is also the
    # exact predicate `preview-state` answers with, so a cold page load and the 45-second poll
    # can never disagree about whether a restore is on offer.
    relaunchable = False if app_id is None else await restorable_presence(app_id)
    return _to_response(
        project, app_id, app_status, relaunchable, is_serving=await _serving_now(db, app_id)
    )


@router.patch(
    "/{project_id}",
    responses=error_responses(
        (400, ErrorEnvelope, "name cannot be cleared"),
        AUTH_401,
        (404, ErrorEnvelope, "Project not found"),
    ),
)
async def patch_project(
    project_id: uuid.UUID, body: ProjectPatch, user: CurrentUser, db: DbSession
) -> ProjectResponse:
    """Apply only the fields present in the body (absent ≠ null). `description` may be
    cleared to NULL; `name` (NOT NULL) may not."""
    project = await owned_project_or_404(db, user.id, project_id)
    fields = body.model_fields_set
    if "name" in fields:
        if body.name is None:
            raise AppApiError(status.HTTP_400_BAD_REQUEST, "name cannot be cleared.")
        project.name = body.name
    if "description" in fields:
        project.description = body.description
    try:
        await db.commit()
    except StaleDataError:
        # The project was deleted between our load and this flush — the loser of that
        # race gets the same non-leaking 404 a PATCH one second later would, not a 500
        # (mirrors conversations' patch-vs-delete handling).
        raise AppApiError(status.HTTP_404_NOT_FOUND, "Project not found.") from None
    await db.refresh(project)
    app_id, app_status = await _project_app(db, user.id, project.id)
    return _to_response(project, app_id, app_status, is_serving=await _serving_now(db, app_id))


# Names the LIVE SESSION as the reason and the action that clears it (R9/D4: refuse, never
# force — forcing would destroy every file change since the last snapshot, and snapshots are
# written only at finalize, so the user would get no signal their work was unsaved).
_BUILD_LIVE_DELETE_MSG = (
    "A build session is still running for this project — end it before deleting."
)

# HOW LONG THE POST-COMMIT REAP WILL WAIT FOR THE PER-USER START LOCK, and it is short on
# purpose. `manager.py`'s `ensure_sandbox` holds that lock across an ENTIRE provision — ACA
# create, image pull, bundle restore, `wait_ready` — so an unbounded acquire parks a delete
# that has ALREADY COMMITTED behind a build the citizen started in another project. Worse
# than slow: if the browser or the proxy gives up first the request is cancelled mid-wait,
# the reap never runs at all, and the container this exists to kill survives while the user
# is told their delete failed for a project that is genuinely gone. Timing out costs one
# sweep cycle; waiting costs the user their delete.
_SANDBOX_REAP_LOCK_WAIT_SECONDS = 2.0


class _WhoseContainer(enum.Enum):
    """Whose container the per-user sandbox registry currently names — THREE answers, because
    two of them are not the same fact and reading them as one silences a real leak.

    `OURS` — this project's; anything left standing is genuinely ours.
    `SOMEONE_ELSES` — the same citizen's container for a DIFFERENT project.
    `NOTHING_REGISTERED` — the registry was read and holds nothing.
    `UNREADABLE` — the question could not be asked at all.

    THE EMPTY REGISTRY MEANS DIFFERENT THINGS ON THE TWO SIDES OF THE LOCK, which is why it is
    its own value rather than being folded into either neighbour. `SandboxClient._write_registry`
    hydrates the hash for a JUST-CREATED container, at the END of a 30-60s provision and under
    the per-user start lock. So OUTSIDE the lock, "empty" is exactly the shape of a provision in
    flight — quite possibly for the very project being deleted — and reading it as "nothing of
    ours survives" would silence the record for a container that is coming up holding that
    project's database credential, with nothing written down and nothing automatic coming for it
    outside production. INSIDE the lock, no provision can be in flight, so "empty" really does
    mean nothing is standing, and treating it as a survivor would file a teardown-incomplete row
    on every ordinary delete of a project whose app is not currently running.
    """

    OURS = "ours"
    SOMEONE_ELSES = "someone_elses"
    NOTHING_REGISTERED = "nothing_registered"
    UNREADABLE = "unreadable"


async def _whose_container_is_registered(user_id: uuid.UUID, app_id: uuid.UUID) -> _WhoseContainer:
    """Read the per-user sandbox registry and say whose container it names.

    THE REGISTRY KEY IS PER-USER, which is the whole reason this question exists: without it,
    "the reap did not happen" and "this project had a container to reap" are the same sentence,
    and the two are not the same fact.
    """
    try:
        reg = await read_registry(get_redis(), user_id)
    except Exception:  # noqa: BLE001 — an unanswerable question, not a failure to report
        logger.warning(
            "project_delete_sandbox_identity_unreadable",
            app_id=str(app_id),
            user_id=str(user_id),
            exc_info=True,
        )
        return _WhoseContainer.UNREADABLE
    if reg is None:
        return _WhoseContainer.NOTHING_REGISTERED
    return (
        _WhoseContainer.OURS
        if reg.get(REGISTRY_FIELD_APP_NAME) == app_name_for(app_id)
        else _WhoseContainer.SOMEONE_ELSES
    )


async def _reap_the_project_sandbox_or_shrug(
    manager: SessionManager,
    sandbox: SandboxClient | None,
    *,
    user_id: uuid.UUID,
    app_id: uuid.UUID | None,
) -> str | None:
    """Take the deleted project's sandbox container down with it (#184). NEVER RAISES.

    Returns the name of a container that is STILL STANDING, or `None` when nothing of this
    project's is left running — which the caller turns into the teardown record (U22). A skip
    that leaves nothing behind (no app, no sandbox configured, a registry naming somebody
    else's container) returns `None`, because nothing survived: only a real leak is reported.

    Post-commit and best-effort, like every other sweep on this path: the rows are already
    gone, so anything that fails here leaves a RUNNING CONTAINER for a human to kill, never a
    500 on a delete that in fact succeeded. It used to say "a logged orphan for the scheduled
    sweep"; there is no scheduled sweep that will take this one. `sweep_all` runs on a timer,
    but `may_destroy_on_this_control_plane` gates the destroy half on `environment ==
    "production"`, and no other reconciler on this path is on a timer at all — the storage and
    database ones are operator-invoked (and the database one deletes nothing), and the
    reclamation janitor's destroy flag is off everywhere. Hence the alarm, and hence the record.
    `reap_user` guards only `SandboxError` around the teardown — its Redis calls are bare by
    module policy — so the explicit `except Exception` below is the mechanism, not the
    intention (it mirrors `salt_the_earth`'s own posture).

    NO SECOND TEARDOWN SEQUENCE. `manager.release_project_sandbox` already does exactly this
    — registry identity check, then `reap_user` — and its docstring states the invariant: there
    is exactly one teardown sequence in this codebase and no route may drift from the reaper's.
    So the reap is `reap_user`'s ordered one (`mark_registry_ending` → `teardown` →
    `delete_registry` → `release_liveness_lease` → `reap_lock`), and this function contributes
    only the identity check in front of it. Releasing the lock and the lease is not garnish:
    `LOCK_TTL_SECONDS = 900`, so a teardown that cleared only the registry would leave the
    citizen unable to start ANY sandbox for fifteen minutes after deleting a project.

    THE IDENTITY CHECK IS NAME-EQUALITY, and deliberately NOT `_registry_serves_and_is_ready`.
    That helper also demands `state == "ready"`, and an entry left at `ending` by an earlier
    failed teardown — which names THIS project's own container — would be skipped and go on
    billing. The check is needed at all because the registry key is per-USER: an unconditional
    clear would destroy a container the same citizen is running for a DIFFERENT project, which
    `refuse_while_build_session_live` cannot cover (it is app-scoped, and a relaunched preview
    holds no lock by design).

    `strict=False`, unlike `release_project_sandbox`'s `True`: that caller is about to act on
    the outcome, and this one is not — a failed teardown here is recorded and left for an
    operator rather than raised at a delete that has already committed. (This said "left for a
    later sweep". `strict=False` does keep the registry entry so a sweep COULD retry, and in
    production one does; everywhere else the entry sits there and the container runs on.)

    `app_id=None` INTO THE DURABLE-COPY GATE IS DELIBERATE, and is the one place this diverges
    from the janitor. The gate spares a container whose work is not provably preserved by
    reading the snapshot — and by the time this runs, `salt_the_earth` and the blob sweep above
    have already destroyed that snapshot. Passing the real id would therefore make the gate
    refuse EVERY container on this path, which is the exact leak the unit exists to close. The
    work is not being abandoned: the user asked for the project and everything in it to be
    deleted, and stated why.
    """
    if app_id is None:
        return None  # a project that never built owns no container
    if sandbox is None:
        # `OptionalSandbox`, NEVER `SandboxDep`: an eager dependency raises
        # `SandboxNotConfiguredError` before the route body, where no `except` of the route's
        # can reach it, so it would 500 every delete on a sandbox-off deployment — including
        # the whole test suite, whose `.env.test` carries no `SANDBOX__*`. Sandbox-off means
        # nothing was ever running, so the skip is also the right answer. See
        # `docs/solutions/design-patterns/
        # eager-fastapi-depends-bypasses-in-body-error-seam-2026-07-21.md`.
        logger.info(
            "project_delete_sandbox_reap_skipped_unconfigured",
            app_id=str(app_id),
            user_id=str(user_id),
        )
        return None
    try:
        # THE LOCK GOES AROUND BOTH THE CHECK AND THE REAP, because without it they are a
        # TOCTOU pair: `reap_user` does its own fresh `read_registry` and tears down whatever
        # it finds, so a concurrent start for a DIFFERENT project landing in the gap has its
        # live container destroyed. This is the same lock `release_project_sandbox` holds.
        lock = manager._start_lock_for(user_id)  # noqa: SLF001 — the reference impl's own lock
        try:
            await asyncio.wait_for(lock.acquire(), _SANDBOX_REAP_LOCK_WAIT_SECONDS)
        except TimeoutError:
            # ASK WHETHER THERE WAS ANYTHING TO REAP BEFORE CLAIMING ONE SURVIVED. The identity
            # check below is on the far side of this lock, so this arm used to report a
            # survivor purely from the fact that it could not get in — and the commonest way in
            # to it is a citizen provisioning a workspace for ANOTHER project, whose 30-60s
            # provision holds the lock for the whole wait. That filed a permanent
            # `project:teardown-incomplete` row naming a container of this project's that was
            # never running, and sent an operator after it. Reading the registry is a lock-free
            # HGETALL and answers the same question the in-lock check asks, so the two arms now
            # agree on the same evidence.
            # ONLY POSITIVE EVIDENCE SUPPRESSES THE RECORD. Out here an EMPTY registry is not
            # "nothing of ours" — it is precisely what a provision in flight looks like, and a
            # provision is the commonest holder of the lock we just failed to take. Naming
            # another project's container is the only reading that actually rules ours out.
            whose = await _whose_container_is_registered(user_id, app_id)
            if whose is _WhoseContainer.SOMEONE_ELSES:
                logger.info(
                    "project_delete_sandbox_reap_skipped_not_ours",
                    app_id=str(app_id),
                    user_id=str(user_id),
                    reason="the lock wait timed out and another project's container is registered",
                )
                return None
            # THE CONTAINER IS STILL UP AND STILL BILLING, and outside production nothing will
            # come for it — `may_destroy_on_this_control_plane` gates the scheduled reap on
            # `environment == "production"`. This line used to say "the scheduled sweep
            # reclaims this container", which was true of exactly one environment and read as
            # true of all of them. An UNREADABLE registry lands here too, deliberately: not
            # knowing is not the same as knowing there is nothing.
            logger.warning(
                TEARDOWN_ARTEFACT_SURVIVED_EVENT,
                artefact="sandbox_container",
                artefact_id=app_name_for(app_id),
                reason="another start held the per-user lock for the whole wait",
                app_id=str(app_id),
                user_id=str(user_id),
                waited_seconds=_SANDBOX_REAP_LOCK_WAIT_SECONDS,
            )
            return app_name_for(app_id)
        try:
            redis = get_redis()
            # IN HERE, EMPTY REALLY DOES MEAN NOTHING SURVIVED, and that asymmetry with the
            # two lock-free arms is the point rather than an oversight: holding the per-user
            # start lock excludes the concurrent provision that makes an empty registry
            # ambiguous out there.
            registered = await _whose_container_is_registered(user_id, app_id)
            if registered is _WhoseContainer.UNREADABLE:
                # THE QUESTION COULD NOT BE ASKED, which is not an answer. The reap's own first
                # act is to read this same registry, so there is nothing to gain by pressing
                # on, and reporting a survivor is the conservative direction when the platform
                # cannot see.
                #
                # ANSWERED HERE RATHER THAN BY RAISING INTO THE BROAD ARM. It used to raise a
                # `RuntimeError` purely to reach that handler — which hardcodes
                # `reason="the reap raised"`, a sentence that is false (`reap_user` was never
                # called) and would send an operator reading the alarm looking for a teardown
                # failure that did not happen. It also cost a second Redis round trip, because
                # that handler asks the same unanswerable question again.
                logger.warning(
                    TEARDOWN_ARTEFACT_SURVIVED_EVENT,
                    artefact="sandbox_container",
                    artefact_id=app_name_for(app_id),
                    reason="the sandbox registry could not be read, so nothing could be checked",
                    app_id=str(app_id),
                    user_id=str(user_id),
                )
                return app_name_for(app_id)
            if registered is not _WhoseContainer.OURS:
                # NOT A LEAK, so not an alarm: either nothing is registered — and under this
                # lock that really does mean nothing is coming up either — or what is
                # registered is a container this citizen is running for a DIFFERENT project
                # and must keep. Nothing of this project's survives.
                logger.info(
                    "project_delete_sandbox_reap_skipped_not_ours",
                    app_id=str(app_id),
                    user_id=str(user_id),
                )
                return None
            reaped = await reap_user(redis, user_id, sandbox, strict=False, app_id=None)
            logger.info(
                "project_delete_sandbox_reaped",
                app_id=str(app_id),
                user_id=str(user_id),
                reaped=reaped,
            )
            if not reaped:
                # The identity check above already confirmed the registry names THIS project's
                # container, so a lenient `reap_user` answering False here means the teardown
                # failed — not that there was nothing to reap.
                logger.warning(
                    TEARDOWN_ARTEFACT_SURVIVED_EVENT,
                    artefact="sandbox_container",
                    artefact_id=app_name_for(app_id),
                    reason="the teardown did not remove the registered container",
                    app_id=str(app_id),
                    user_id=str(user_id),
                )
                return app_name_for(app_id)
        finally:
            lock.release()
    except Exception:  # noqa: BLE001 — post-commit: an alarm and a record, never a 500 (R3)
        # SAME QUESTION AS THE TIMEOUT ARM, and for the same reason: a Redis blip on the way in
        # is not evidence that this project had a container. If the registry can be read now
        # and does not name ours, nothing of this project's survived and the record must not
        # say otherwise. Unreadable or ours -> report, which is where an actual failed teardown
        # lands.
        # Same rule as the timeout arm, and for the same reason: a Redis blip on the way in is
        # not evidence about what is standing, and neither is an empty hash while a provision
        # may be mid-flight. Only another project's name rules ours out.
        if await _whose_container_is_registered(user_id, app_id) is _WhoseContainer.SOMEONE_ELSES:
            logger.info(
                "project_delete_sandbox_reap_skipped_not_ours",
                app_id=str(app_id),
                user_id=str(user_id),
                reason="the reap raised and the registry names another project's container",
            )
            return None
        logger.warning(
            TEARDOWN_ARTEFACT_SURVIVED_EVENT,
            artefact="sandbox_container",
            artefact_id=app_name_for(app_id),
            reason="the reap raised",
            app_id=str(app_id),
            user_id=str(user_id),
            exc_info=True,
        )
        return app_name_for(app_id)
    return None


@router.delete(
    "/{project_id}",
    response_model=OkResponse,
    responses=error_responses(
        AUTH_401,
        (404, ErrorEnvelope, "Project not found"),
        (409, ErrorEnvelope, "A build session is live for this project's app"),
        (503, ErrorEnvelope, "Build coordination temporarily unavailable"),
    ),
)
async def delete_project(
    project_id: uuid.UUID,
    body: ProjectDeleteRequest,
    user: CurrentUser,
    db: DbSession,
    storage: StorageDep,
    container_store: ContainerStoreDep,
    sandbox: OptionalSandbox,
    manager: SessionManagerDep,
) -> OkResponse:
    """Cascade-delete the project and every child it owns.

    IT TAKES A BODY, which is unusual for DELETE and worth naming. #158 §13.2 requires the
    person deleting to state WHY, in 5-50 words, and a 50-word reason does not belong in a
    query string. RFC 9110 says content on a DELETE has no defined semantics, and httpx
    declines to offer `json=` on `.delete()` for that reason — tests use `.request("DELETE",
    ...)`. nginx and the container ingress both forward the body, and the portal is the only
    client, so this is safe here; it is recorded rather than assumed. The alternative, a
    `POST /{id}/delete` matching `disable`/`unpublish`, is a bigger contract change than
    adding a required field to the route that already exists. Rows are deleted inside the
    transaction and committed; object-store blobs AND each app's per-app Blob container are swept
    only AFTER commit, best-effort, so a rolled-back delete never destroys a blob/container a
    restored row still points at (KD-3). The two sweeps hit two different stores (KTD-7).

    The submissions prefixes are re-enumerated AFTER the commit and folded into the sweep list
    (R8/R12), so a bundle written between the cascade's pre-commit gather and the commit is
    still swept instead of surviving under an app id whose row is gone. The narrower residual —
    a write landing after that re-walk — is NOT closed here; see `delete_project_cascade`.

    A live build session for THIS project's app refuses the delete (409, R9) rather than
    racing it. The guard is app-scoped, so a build in one project never blocks the delete of
    another. It does NOT cover a relaunched preview, which holds no lock by design — and that
    is what the post-commit sandbox reap is for (#184, `_reap_the_project_sandbox_or_shrug`):
    once the rows are committed, the registry is asked whether it still names THIS project's
    container and, if it does, `reap_user` takes it down. Before it, a citizen who deleted a
    project they had just previewed left the container running at roughly $2.60/day until
    they next built something.

    THE FORCE-DROP IS STILL THE GUARANTEE, and the reap does not demote it. The reap is
    best-effort and skippable by design — an unconfigured sandbox, a busy start lock or a
    Redis blip all leave the container standing, and outside production nothing automatic
    takes it down (the scheduled reap's destroy half is production-only) — and a DEPLOYED or
    published container was never in the sandbox registry to be found at all. So the project's
    own database is torn down with `salt_the_earth` (sever, then `DROP DATABASE ... WITH
    (FORCE)`) exactly as before: whatever is still holding live connections at delete time,
    the force-drop is what guarantees it stops reading. It runs post-commit and never raises:
    the rows are already gone, so a failed drop is a leak a HUMAN has to clear — the
    per-project-database reconciler is operator-invoked and report-only, so nothing collects
    it on its own — never a 500 on a delete that in fact succeeded.

    WHAT SURVIVED IS ON THE RECORD (U22/R7). Each post-commit arm reports what it could not
    destroy; anything left standing raises `TEARDOWN_ARTEFACT_SURVIVED_EVENT` and lands, once,
    in a `project:teardown-incomplete` audit row naming every surviving artefact. The CITIZEN
    is not told, deliberately: for them a delete is done when the code, the files and the
    database are gone, and this platform has no notification path to promise an operator has
    been alerted. The response is `{"ok": true}` either way."""
    project = await owned_project_or_404(db, user.id, project_id)
    # READ FIRST, BEFORE ANYTHING ELSE IN THIS FUNCTION RUNS (#184). This is the only copy of
    # the description that will exist after the cascade: it lives on the `projects` row
    # `delete_project_cascade` deletes, and `description_tsv` is a lossy `to_tsvector` of it
    # rather than a second copy. The tombstone insert below is only PENDING until the
    # cascade's autoflush, so binding the value into a local HERE — rather than reaching for
    # `project.description` down there — is what makes the read's ordering explicit instead of
    # incidental: a later change that moves the insert past the cascade (to get an exact
    # count, say) would silently record an empty description otherwise, and there is no source
    # to repair it from. Coalesced because `projects.description` is NULL when there is none
    # and the column that keeps it is NOT NULL — the explicit half of a bridge the model's two
    # defaults also make; see there for why that asymmetry is deliberate and why none of the
    # three is load-bearing alone.
    doomed_description = project.description or ""
    # THE TOMBSTONE, written before the cascade removes what it describes (#158 §13.3).
    # Inside the caller's transaction, so a rolled-back delete leaves no record of a
    # deletion that did not happen — and a committed one always has its reason.
    #
    # Values, not foreign keys: the project row is gone a few lines below, so anything this
    # references by id would be unreadable. The counts are captured HERE because they cannot
    # be reconstructed once the children are deleted.
    chats_deleted = int(
        await db.scalar(
            sa.select(sa.func.count())
            .select_from(Conversation)
            # BOTH predicates, matching `delete_project_cascade` exactly. Counting on
            # `project_id` alone is not exploitable — ownership is already checked above —
            # but it makes the recorded number and the rows actually deleted two different
            # sets by construction, on a table whose only job is to be accurate about what
            # went with the project.
            .where(Conversation.project_id == project.id, Conversation.user_id == user.id)
        )
        or 0
    )
    # R9: refuse while this project's app is being built. Owner-scoped discovery (ADR-0004);
    # a project with no app row can have no build session, so the guard is skipped rather
    # than fired — an app-less project must not inherit another project's live build.
    app_id, _app_status = await _project_app(db, user.id, project.id)
    if app_id is not None:
        await refuse_while_build_session_live(
            user.id, conflict_message=_BUILD_LIVE_DELETE_MSG, app_id=app_id
        )
    # The database handles, as plain scalars, BEFORE the cascade: deleting the project
    # cascades its `project_databases` row away, so post-commit there is nothing left to
    # read them from — the same reason `app_container_ids` are plain UUIDs (KD-8).
    handles = await teardown_handles(db, project.id)
    # Captured before the cascade, for the same reason as the chat count: `handles` is read
    # from a row the cascade deletes.
    db.add(
        DeletedProject(
            project_id=project.id,
            project_name=project.name,
            # Captured at the top of the function, not read here — see `doomed_description`.
            project_description=doomed_description,
            owner_id=project.user_id,
            owner_email=user.email,
            deleted_by=user.id,
            # BOTH from the session, never the body. `deleted_by` is the durable key and
            # this is its readable label, so they must name the same person by construction;
            # a client-supplied name could not be trusted by the administrator who reads it.
            # `display_name` is nullable — Entra does not always give one — and the email
            # identifies the account just as well, so it stands in rather than leaving the
            # one human-readable field on the row blank.
            deleted_by_name=user.display_name or user.email,
            remark=body.remark,
            chats_deleted=chats_deleted,
            had_app=app_id is not None,
            had_database=handles is not None,
        )
    )
    # EVERYTHING FROM HERE THROUGH THE COMMIT IS THE GUARDED SECTION. The tombstone insert
    # above is only PENDING — SQLAlchemy autoflushes it at the next query that needs a
    # consistent view of the database, and `delete_project_cascade` issues exactly that kind
    # of query. The loser of a race therefore hits `deleted_projects.project_id`'s unique
    # index INSIDE the cascade's own autoflush, not at the explicit `db.commit()` below —
    # confirmed by running this without the wider try: the IntegrityError surfaced from
    # `delete_project_cascade`, not from the commit call.
    try:
        cleanup = await delete_project_cascade(db, project, storage, user_id=user.id)
        await append_audit(
            db,
            actor_id=user.id,
            action="project:delete",
            resource_type="project",
            resource_id=str(project_id),
        )
        if handles is not None:
            # NAMES only (D11) — never the DSN. `appId` is what makes this project-scoped
            # row visible in the app's audit drawer (`admin.read_audit` matches on it); an
            # app-less project simply has no app to file it under.
            detail: dict[str, str] = {"dbName": handles.db_name, "roleName": handles.role_name}
            if app_id is not None:
                detail["appId"] = str(app_id)
            await append_audit(
                db,
                actor_id=user.id,
                action="db:drop",
                resource_type="project",
                resource_id=str(project_id),
                detail=detail,
            )
        await db.commit()
    except IntegrityError:
        # THE LOSER OF A DOUBLE-SUBMIT OR A RETRY. `owned_project_or_404` takes no row lock
        # and this cascade deletes through Core `sa.delete()`, so no ORM staleness check
        # fires the way `patch_project`'s does — the first signal either request gets that
        # it lost the race is `deleted_projects.project_id`'s unique index refusing the
        # second tombstone. By then the winner's transaction has already committed and the
        # project is genuinely gone, so this mirrors `patch_project`'s own StaleDataError
        # handling: the loser gets the same non-leaking 404 a request one second later
        # would, not a 500 for a delete that in fact succeeded.
        #
        # THE EXPLICIT ROLLBACK IS LOAD-BEARING HERE IN A WAY IT ISN'T FOR StaleDataError.
        # Postgres aborts the whole transaction the instant a real constraint violation
        # reaches it — every statement after this one would answer "current transaction is
        # aborted" until something rolls it back — whereas `StaleDataError` is SQLAlchemy
        # catching a zero-row UPDATE/DELETE before any failing SQL is sent, so that
        # connection was never poisoned. `get_db`'s own `except Exception` rolls back too,
        # but only for what escapes this function; nothing downstream of this handler
        # (including a caller sharing this session) should have to know that.
        await db.rollback()
        raise AppApiError(status.HTTP_404_NOT_FOUND, "Project not found.") from None
    # WHAT THE TEARDOWN COULD NOT DESTROY, as `(artefact, identifier)` pairs. Every arm below
    # reports rather than raises — a raise would 500 a delete that has already committed — and
    # the list becomes ONE audit row at the bottom. It stays empty on the overwhelming majority
    # of deletes, which is what makes a row that exists at all worth reading.
    survivors: list[tuple[str, str]] = []
    if handles is not None:
        # FIRST of the post-commit sweeps, because it is the one that stops data being read:
        # sever, then force-drop the database, then drop the role. Never raises.
        if not await salt_the_earth(db_name=handles.db_name, role_name=handles.role_name):
            survivors.append(("app_database", handles.db_name))
    # Post-commit, pre-sweep: re-walk the submission prefixes so the sweep list reflects the
    # store as it is NOW. `app_container_ids` are plain UUIDs captured pre-commit, so reading
    # them here triggers no `expire_on_commit` lazy I/O (KD-8). Dedup preserves order and keeps
    # the pre-commit list in play even if the re-walk fails (it logs rather than raising).
    resweep = await resweep_submission_prefixes(storage, cleanup.app_container_ids)
    survivors.extend(
        ("blob", key)
        for key in await sweep_blobs(storage, list(dict.fromkeys([*cleanup.blob_keys, *resweep])))
    )
    survivors.extend(
        ("app_container", str(container_id))
        for container_id in await sweep_app_containers(container_store, cleanup.app_container_ids)
    )
    # The published container app. Same pre-commit id list — the published name is a pure
    # function of the app id — because after the cascade there is nothing left in the database
    # that names the running container, and the sandbox reaper cannot see it (it sweeps the
    # Redis registry, which a published app is never written to).
    #
    # IT ANSWERS WITH SURVIVORS, like every other arm on this path. It used to answer with a
    # COUNT, which made this block guess: short of the id count meant "one did not go", so it
    # named EVERY id as a survivor — and it had to re-read `settings.deploy` first, because a
    # count of zero also meant "publishing is switched off and nothing was ever published".
    # Both problems were the return type's. An audit row that names an app which was in fact
    # deleted is worse than one that names none: it sends an operator after something that is
    # not there. The per-id detail is on the alarm the helper itself raised.
    # Read once and handed to the registry sweep below, which needs the config itself.
    published_config = settings.deploy
    survivors.extend(
        ("published_app", str(i)) for i in await sweep_published_apps(cleanup.app_container_ids)
    )
    # ...and the image the published container was built from. Deleting a project must not
    # leave the citizen's compiled source sitting in the registry under a name nothing in the
    # database points at any more (#184, R1/R6). Derived, never stored — see `registry_delete`.
    #
    # ONLY THE APPS THAT COULD HAVE ONE, captured pre-commit by the cascade: a registry that
    # refuses the delete credential answers 401/403 for every id it is handed, so sweeping apps
    # that were never built would name repositories that never existed as survivors on every
    # delete — an operator sent looking for something that was never there.
    survivors.extend(
        ("registry_repository", repository)
        for repository in await sweep_app_repositories(
            cleanup.built_app_ids, config=published_config
        )
    )
    # ...and LAST, the sandbox container, if the registry still says one of this project's is
    # up. After the sweeps deliberately: the durable-copy gate reads the snapshot they have
    # just destroyed, which is why the reap is opted OUT of that gate (see the helper).
    standing = await _reap_the_project_sandbox_or_shrug(
        manager, sandbox, user_id=user.id, app_id=app_id
    )
    if standing is not None:
        survivors.append(("sandbox_container", standing))
    await record_what_survived(db, actor_id=user.id, project_id=project_id, survivors=survivors)
    return OkResponse(ok=True)


# THE DESCRIPTION GENERATOR'S ONLY PER-USER SPEND BOUND, and the reason it needs one:
# what this route spends is deliberately recorded under `review` and never counted back
# into the citizen's daily budget (R14) — the platform's reasoning about their code is
# not theirs to pay for. That exemption travelled here from the classification review;
# the BOUND that made it safe there did not. Without one, `enforce_daily_limit` admits
# call N for every N, and each call ships up to 600,000 characters of app source to the
# premium deployment — from a citizen who may have already exhausted their build budget.
#
# Six in a quarter of an hour is far more than revising a description ever needs (R19's
# revise loop is a person reading a paragraph and pressing again), and the refusal costs
# nothing that cannot be retried: the description that exists stays, and the button works
# again shortly.
DESCRIPTION_RATE_LIMIT = 6
DESCRIPTION_RATE_WINDOW_SECONDS = 15 * 60


# THE BUCKET IS CHARGED AT THE POINT OF SPEND, not at the door, which is why this is a plain
# limiter object rather than the `rate_limit(...)` dependency its siblings use. A dependency
# runs before the route body, so it would count every refusal too — and this route's commonest
# refusal is a 409 for a project with nothing built yet, which spends nothing at all. Six of
# those and a citizen who then builds their app finds the button locked for a quarter of an
# hour over requests that never reached the model. The route hits this AFTER the 409/503/429
# guards, so what is bounded is generations, which is what the bound is for.
_description_limiter = InProcessRateLimiter(
    limit=DESCRIPTION_RATE_LIMIT, window_seconds=DESCRIPTION_RATE_WINDOW_SECONDS
)

_DESCRIPTION_RATE_MESSAGE = (
    "Too many description generations in a short time. Please wait a few minutes and try again."
)


@router.post(
    "/{project_id}/description:generate",
    response_model=ProjectResponse,
    responses={
        # TWO DIFFERENT 429 BODIES REACH THIS ROUTE and `error_responses` refuses a
        # duplicated code, so this one is written out: the daily gate answers its 5-key
        # body, the limiter above answers the plain `{"error": {"message"}}` envelope.
        # Documented as the union rather than as whichever one was written first — a
        # client that parses the schema would break on the other.
        429: {
            "model": DailyTokenLimitBody | ErrorEnvelope,
            "description": (
                "Daily token limit exceeded (5-key body), or too many generations "
                "started in a short time (error envelope)"
            ),
        },
        **error_responses(
            AUTH_401,
            (404, ErrorEnvelope, "Project not found"),
            (409, ErrorEnvelope, "Nothing to generate from yet (no app / no code)"),
            (500, ErrorEnvelope, "The description generation failed"),
            (503, ErrorEnvelope, "Claude client not configured"),
        ),
    },
)
async def generate_description(
    project_id: uuid.UUID, user: CurrentUser, db: DbSession, model: ModelDep
) -> ProjectResponse | JSONResponse:
    """Generate (or revise) the project description from its app's code (KD-5). Reads the
    project's ONE app's `current_code` (KD-4/9); a fresh project (no app / NULL code) is a
    409 "nothing to generate from yet". A citizen already at their daily limit is refused
    here, but what this generates does not itself come out of that limit (R14); if a
    description already exists it is fed in so generation revises it (R19). The result is
    length-capped (KD-8) and stored on the project."""
    project = await owned_project_or_404(db, user.id, project_id)
    if model is None:
        raise AppApiError(status.HTTP_503_SERVICE_UNAVAILABLE, "Claude client not configured.")

    app = await db.scalar(
        sa.select(AppRegistry).where(
            AppRegistry.project_id == project.id, AppRegistry.user_id == user.id
        )
    )
    source = extract_source(app.current_code) if app is not None else ""
    if app is None or not source:
        raise AppApiError(
            status.HTTP_409_CONFLICT, "Nothing to generate from yet — build the app first."
        )

    # GATED LIKE A NORMAL TURN, BILLED UNLIKE ONE. The check runs BEFORE the model call and
    # answers with the 5-key 429 body, so someone out of budget is told the same thing here as
    # anywhere else. What this turn then spends is recorded under `review` and never counted
    # back into that budget (R14, `services/projects/describe.py`) — the platform's reasoning
    # about the citizen's code is not the citizen's to pay for.
    try:
        await enforce_daily_limit(db, user.id)
    except DailyTokenLimitExceededError as exc:
        return exc.as_response()

    # LAST GUARD BEFORE THE MODEL, deliberately. Everything above can refuse without spending
    # anything — no app, no code, no client, or a citizen already out of daily budget — and a
    # bound charged for those would take the button away over requests that cost nothing. From
    # here on, a request that passes is a request that generates. Per-user bucket; the key is
    # built from the validated session, never from anything the caller sends.
    if not _description_limiter.hit(f"project-description:{user.id}"):
        raise RateLimitExceededError(_DESCRIPTION_RATE_MESSAGE)

    try:
        project.description = await generate_project_description(
            db, model, user.id, source=source, current_description=project.description
        )
    except Exception as exc:
        # A Foundry/model failure is this route's own explicit 500 envelope, never the
        # generic `{detail}` handler.
        logger.exception("project_description_generation_failed")
        raise AppApiError(
            status.HTTP_500_INTERNAL_SERVER_ERROR, "The description generation failed."
        ) from exc
    try:
        await db.commit()
    except StaleDataError:
        # The project was deleted mid-generate. The usage row rides this commit, so the
        # 404 rolls the metering back too — an accepted, bounded loss on this rare race
        # (not worth rewiring the usage write into its own transaction).
        raise AppApiError(status.HTTP_404_NOT_FOUND, "Project not found.") from None
    await db.refresh(project)
    return _to_response(project, app.id, app.status, is_serving=await _serving_now(db, app.id))
