"""Projects HTTP endpoints — user-scoped CRUD for the parent container.

A project is the home a citizen developer builds one tool inside. Delete cascades through the
blob-aware, rollback-safe project-delete service.

Errors use the ported `{"error": {"message": ...}}` shape (`AppApiError`), documented with
the shared `error_responses(...)` + `AUTH_401` builders.
"""

from __future__ import annotations

import asyncio
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
from src.services.build_sessions import SessionManager, app_name_for, read_registry, reap_user
from src.services.build_sessions.manager import restorable_presence
from src.services.deploy.liveness import live_app_ids
from src.services.deploy.teardown import sweep_published_apps
from src.services.projects import (
    delete_project_cascade,
    extract_source,
    generate_project_description,
    owned_project_or_404,
    resweep_submission_prefixes,
)
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
    is unconfigured (dev/test) — `| None` unlike `StorageDep`, so the delete still succeeds with
    the container sweep skipped. A dependency rather than a bare `get_app_container_store()` call
    so tests can swap a fake through `dependency_overrides`."""
    return get_app_container_store()


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
    """The project's ONE app's (id, status) — read-only discovery for the response (one app
    per project, which is what makes `.one_or_none()` safe) — or (None, None) for a fresh
    project."""
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
    rather than re-deriving it. `None` means the project has no app at all, which is a
    confirmed False rather than an unknown: nothing can be serving."""
    # Re-deriving liveness here instead of reading the shared collapse is the drift
    # `liveness.py` exists to prevent — not only between surfaces, but between the list and
    # the detail view of the same project.
    if app_id is None:
        return False
    live = live_app_ids().subquery()
    return bool(await db.scalar(sa.select(sa.exists().where(live.c.app_id == app_id))))


@router.post("", status_code=status.HTTP_201_CREATED, responses=error_responses(AUTH_401))
async def create_project(body: ProjectCreate, user: CurrentUser, db: DbSession) -> ProjectResponse:
    """Create a project owned by the caller, then provision its own database.

    `name` is stripped/bounded and an empty/whitespace `description` is normalized to NULL at
    the schema boundary. The database provision is best-effort: a substrate hiccup still
    answers a normal 201, and the project is usable."""
    # The app row is NOT minted here — it stays lazily created at first build, so a fresh
    # project still reports `appId: null` (`test_app_discovery_null_for_fresh_project…`).
    #
    # The provision runs AFTER the commit and is BEST-EFFORT, both deliberately. After,
    # because `ensure_project_database` commits its own claim and its own terminal marker —
    # running it first would commit this request's half-built transaction. Best-effort,
    # because a substrate hiccup must never strand or 500 a project the user already owns:
    # the next build's lazy ensure (`provision_app_database`) re-runs the idempotent sequence.
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
    """Provision the project's database; on failure log and carry on (never 500)."""
    # Resolved inside the body rather than through a `Depends`, which would be solved before
    # this route's first statement: an unconfigured or unreachable substrate would then 500 a
    # create that in fact succeeded.
    #
    # Only the exception TYPE is logged, never its message: a failing `CREATE ROLE` surfaces
    # as a SQLAlchemy `DBAPIError` whose string carries the offending `[SQL: ...]` — which
    # for that one statement contains the role's password literal.
    try:
        await ensure_project_database(db, project_id)
    except Exception as exc:  # noqa: BLE001 — degraded state, not a failed create
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
    case-insensitive name/description substring.

    `total` is read separately from the page, so a create landing between the two reads can
    make the count and the rows disagree for one render; say something true when they do
    rather than asserting either number. A page past the end is an empty `items` with the
    real `total`, not a 404."""
    # IT PAGES BY OFFSET, and `pagination.py` says the platform does not. Numbered pages and
    # a rows-per-page selector — `Showing 1-8 of 12`, `Page 1 of 2` — are the product
    # requirement, and neither is expressible without a `total`, which keyset does not provide.
    #
    # THE MARKETPLACE'S ARGUMENT DOES NOT TRANSFER, and reaching for it would be the quiet kind
    # of wrong. That one reads: "the keyset rule protects a list you are writing to, this
    # catalog is read-only and small". This list IS written to — create and delete both act on
    # it, and under `ORDER BY id DESC` a new project lands at position 0, the worst case for
    # OFFSET rather than a benign one.
    #
    # What makes OFFSET acceptable here is narrower: the list is OWNER-SCOPED and effectively
    # SINGLE-WRITER. Every row is `WHERE user_id = :me`, and the only person inserting or
    # deleting rows in it is the person reading it. The skew the keyset rule guards against — a
    # busy shared table shifting under a stranger's page walk — is here one citizen with two
    # tabs open. A real window, but bounded by one person's own actions.
    #
    # The `total`/page split is under READ COMMITTED, two reads and not one snapshot.
    page = clean_page(page)
    search = clean_search(q)
    limit = clean_limit(limit)
    # LEFT-JOIN the project's ONE app (uq_app_registry_project) so the page carries the
    # read-only appId/appStatus discovery without an N+1; the outer join keeps app-less
    # projects listed.
    # ONE JOIN, not one request per row. The status column needs to know whether each app is
    # SERVING, and "live = deployed / published, with a url" is a deployment fact rather than
    # a lifecycle one. `PublishStatusChip` gets it from `getDeployment(projectId)`,
    # which is fine for one project page and is an N-way fan-out on a list — so the list
    # reads the same definition set-wise instead, via the shared `live_app_ids` collapse.
    # SCOPED to this owner, and the scoping happens INSIDE the collapse: an
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
    # (`uq_app_registry_project` — one app per project), and `live.c.app_id` is unique
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
    """The three numbers above the project list.

    These are the citizen's OWN projects; `/admin/apps/counts` is the across-owners count, so
    the two answer different questions and are not each other's cross-check."""
    # DECLARED BEFORE `/{project_id}`, and that ordering is load-bearing: FastAPI matches in
    # declaration order, so a `/counts` registered after the parameterised route would be
    # swallowed by it and answer 422 on a UUID parse instead.
    #
    # Three aggregates over one owner's rows, no row projection and no per-app probing. The
    # liveness half reads the SHARED `live_app_ids` collapse, which is the whole reason this is
    # not three ad-hoc queries: the list's status column reads the same definition, so
    # "3 in production" above a list showing two live apps is not expressible.
    # SCOPED to this owner inside the collapse, for the same reason as `list_projects` — see
    # `live_app_ids`'s docstring.
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
    # This is the ONE surface that offers Relaunch, so the one that pays for the head-check.
    # No app row means no bundle can exist, and that is a CONFIRMED absent rather than an
    # unknown: skipping the store call here is an answer, not an omission.
    #
    # `restorable_presence`, NOT `snapshot_presence`: the saved bundle alone missed the
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


# Names the LIVE SESSION as the reason and the action that clears it: refuse, never
# force — forcing would destroy every file change since the last snapshot, and snapshots are
# written only at finalize, so the user would get no signal their work was unsaved.
_BUILD_LIVE_DELETE_MSG = (
    "A build session is still running for this project — end it before deleting."
)

# HOW LONG THE POST-COMMIT REAP WILL WAIT FOR THE PER-USER START LOCK, and it is short on
# purpose. `manager.py`'s `_start_locked` holds that lock across an ENTIRE provision — ACA
# create, image pull, bundle restore, `wait_ready` — so an unbounded acquire parks a delete
# that has ALREADY COMMITTED behind a build the citizen started in another project. Worse
# than slow: if the browser or the proxy gives up first the request is cancelled mid-wait,
# the reap never runs at all, and the container this exists to kill survives while the user
# is told their delete failed for a project that is genuinely gone. Timing out costs one
# sweep cycle; waiting costs the user their delete.
_SANDBOX_REAP_LOCK_WAIT_SECONDS = 2.0


async def _reap_the_project_sandbox_or_shrug(
    manager: SessionManager,
    sandbox: SandboxClient | None,
    *,
    user_id: uuid.UUID,
    app_id: uuid.UUID | None,
) -> None:
    """Take the deleted project's sandbox container down with it. NEVER RAISES.

    Post-commit and best-effort, like every other sweep on this path: the rows are already
    gone, so anything that fails here is a logged orphan for the scheduled sweep, never a 500
    on a delete that in fact succeeded. `reap_user` guards only `SandboxError` around the
    teardown — its Redis calls are bare by module policy — so the explicit `except Exception`
    below is the mechanism, not the intention (it mirrors `salt_the_earth`'s own posture).

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
    the outcome, and this one is not — a failed teardown here is left for a later sweep rather
    than raised at a delete that has already committed.

    `app_id=None` INTO THE DURABLE-COPY GATE IS DELIBERATE, and is the one place this diverges
    from the janitor. The gate spares a container whose work is not provably preserved by
    reading the snapshot — and by the time this runs, `salt_the_earth` and the blob sweep above
    have already destroyed that snapshot. Passing the real id would therefore make the gate
    refuse EVERY container on this path, which is the exact leak the unit exists to close. The
    work is not being abandoned: the user asked for the project and everything in it to be
    deleted, and stated why.
    """
    if app_id is None:
        return  # a project that never built owns no container
    if sandbox is None:
        # `OptionalSandbox`, NEVER `SandboxDep`: an eager dependency raises
        # `SandboxNotConfiguredError` before the route body, where no `except` of the route's
        # can reach it, so it would 500 every delete on a sandbox-off deployment — including
        # the whole test suite, whose `.env.test` carries no `SANDBOX__*`. Sandbox-off means
        # nothing was ever running, so the skip is also the right answer.
        logger.info(
            "project_delete_sandbox_reap_skipped_unconfigured",
            app_id=str(app_id),
            user_id=str(user_id),
        )
        return
    try:
        # THE LOCK GOES AROUND BOTH THE CHECK AND THE REAP, because without it they are a
        # TOCTOU pair: `reap_user` does its own fresh `read_registry` and tears down whatever
        # it finds, so a concurrent start for a DIFFERENT project landing in the gap has its
        # live container destroyed. This is the same lock `release_project_sandbox` holds.
        lock = manager._start_lock_for(user_id)  # noqa: SLF001 — the reference impl's own lock
        try:
            await asyncio.wait_for(lock.acquire(), _SANDBOX_REAP_LOCK_WAIT_SECONDS)
        except TimeoutError:
            logger.warning(
                "project_delete_sandbox_reap_skipped_lock_busy",
                app_id=str(app_id),
                user_id=str(user_id),
                waited_seconds=_SANDBOX_REAP_LOCK_WAIT_SECONDS,
                hint="a start is in flight; the scheduled sweep reclaims this container",
            )
            return
        try:
            redis = get_redis()
            reg = await read_registry(redis, user_id)
            if reg is None or reg.get(REGISTRY_FIELD_APP_NAME) != app_name_for(app_id):
                logger.info(
                    "project_delete_sandbox_reap_skipped_not_ours",
                    app_id=str(app_id),
                    user_id=str(user_id),
                )
                return
            reaped = await reap_user(redis, user_id, sandbox, strict=False, app_id=None)
            logger.info(
                "project_delete_sandbox_reaped",
                app_id=str(app_id),
                user_id=str(user_id),
                reaped=reaped,
            )
        finally:
            lock.release()
    except Exception:  # noqa: BLE001 — post-commit: a logged orphan, never a 500
        logger.warning(
            "project_delete_sandbox_reap_failed",
            app_id=str(app_id),
            user_id=str(user_id),
            exc_info=True,
        )


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

    Requires a body stating WHY, in 5-50 words, which is recorded as a tombstone. Rows are
    deleted inside the transaction and committed; object-store blobs, each app's per-app Blob
    container, and the project's own PostgreSQL database are torn down only AFTER the commit,
    best-effort. A live build session for THIS project's app refuses the delete with 409
    rather than racing it."""
    # IT TAKES A BODY, which is unusual for DELETE and worth naming. A 50-word reason does not
    # belong in a query string. RFC 9110 says content on a DELETE has no defined semantics, and
    # httpx declines to offer `json=` on `.delete()` for that reason — tests use
    # `.request("DELETE", ...)`. nginx and the container ingress both forward the body, and the
    # portal is the only client, so this is safe here; it is recorded rather than assumed. The
    # alternative, a `POST /{id}/delete` matching `disable`/`unpublish`, is a bigger contract
    # change than adding a required field to the route that already exists.
    #
    # Post-commit sweeping is what makes a rolled-back delete safe: it never destroys a
    # blob/container a restored row still points at. The two sweeps hit two different stores.
    # The submissions prefixes are re-enumerated AFTER the commit and folded into the sweep
    # list, so a bundle written between the cascade's pre-commit gather and the commit is still
    # swept instead of surviving under an app id whose row is gone. The narrower residual — a
    # write landing after that re-walk — is NOT closed here; see `delete_project_cascade`.
    #
    # The 409 guard is app-scoped, so a build in one project never blocks the delete of
    # another. It does NOT cover a relaunched preview, which holds no lock by design — and
    # that is what the post-commit sandbox reap is for (`_reap_the_project_sandbox_or_shrug`):
    # once the rows are committed, the registry is asked whether it still names THIS project's
    # container and, if it does, `reap_user` takes it down. Before it, a citizen who deleted a
    # project they had just previewed left the container running at roughly $2.60/day until
    # they next built something.
    #
    # THE FORCE-DROP IS STILL THE GUARANTEE, and the reap does not demote it. The reap is
    # best-effort and skippable by design — an unconfigured sandbox, a busy start lock or a
    # Redis blip all leave the container standing for the scheduled sweep — and a DEPLOYED or
    # published container was never in the sandbox registry to be found at all. So the
    # project's own database is torn down with `salt_the_earth` (sever, then `DROP DATABASE
    # ... WITH (FORCE)`) exactly as before: whatever is still holding live connections at
    # delete time, the force-drop is what guarantees it stops reading. It runs post-commit and
    # never raises: the rows are already gone, so a failed drop is a logged orphan for the
    # reconciler, never a 500 on a delete that in fact succeeded.
    project = await owned_project_or_404(db, user.id, project_id)
    # THE TOMBSTONE, written before the cascade removes what it describes.
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
    # Refuse while this project's app is being built. A project with no app row can have no
    # build session, so the guard is skipped rather than fired — an app-less project must not
    # inherit another project's live build.
    app_id, _app_status = await _project_app(db, user.id, project.id)
    if app_id is not None:
        await refuse_while_build_session_live(
            user.id, conflict_message=_BUILD_LIVE_DELETE_MSG, app_id=app_id
        )
    # The database handles, as plain scalars, BEFORE the cascade: deleting the project
    # cascades its `project_databases` row away, so post-commit there is nothing left to
    # read them from — the same reason `app_container_ids` are plain UUIDs.
    handles = await teardown_handles(db, project.id)
    # Captured before the cascade, for the same reason as the chat count: `handles` is read
    # from a row the cascade deletes.
    db.add(
        DeletedProject(
            project_id=project.id,
            project_name=project.name,
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
            # NAMES only — never the DSN. `appId` is what makes this project-scoped
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
    if handles is not None:
        # FIRST of the post-commit sweeps, because it is the one that stops data being read:
        # sever, then force-drop the database, then drop the role. Never raises.
        await salt_the_earth(db_name=handles.db_name, role_name=handles.role_name)
    # Post-commit, pre-sweep: re-walk the submission prefixes so the sweep list reflects the
    # store as it is NOW. `app_container_ids` are plain UUIDs captured pre-commit, so reading
    # them here triggers no `expire_on_commit` lazy I/O. Dedup preserves order and keeps
    # the pre-commit list in play even if the re-walk fails (it logs rather than raising).
    resweep = await resweep_submission_prefixes(storage, cleanup.app_container_ids)
    await sweep_blobs(storage, list(dict.fromkeys([*cleanup.blob_keys, *resweep])))
    await sweep_app_containers(container_store, cleanup.app_container_ids)
    # Last: the published container app itself. Same pre-commit id list — the published name
    # is a pure function of the app id — because after the cascade there is nothing left in
    # the database that names the running container, and the sandbox reaper cannot see it
    # (it sweeps the Redis registry, which a published app is never written to).
    await sweep_published_apps(cleanup.app_container_ids)
    # ...and LAST, the sandbox container, if the registry still says one of this project's is
    # up. After the sweeps deliberately: the durable-copy gate reads the snapshot they have
    # just destroyed, which is why the reap is opted OUT of that gate (see the helper).
    await _reap_the_project_sandbox_or_shrug(manager, sandbox, user_id=user.id, app_id=app_id)
    return OkResponse(ok=True)


@router.post(
    "/{project_id}/description:generate",
    response_model=ProjectResponse,
    responses=error_responses(
        AUTH_401,
        (404, ErrorEnvelope, "Project not found"),
        (409, ErrorEnvelope, "Nothing to generate from yet (no app / no code)"),
        (429, DailyTokenLimitBody, "Daily token limit exceeded"),
        (500, ErrorEnvelope, "The description generation failed"),
        (503, ErrorEnvelope, "Claude client not configured"),
    ),
)
async def generate_description(
    project_id: uuid.UUID, user: CurrentUser, db: DbSession, model: ModelDep
) -> ProjectResponse | JSONResponse:
    """Generate (or revise) the project description from its app's code. Reads the
    project's ONE app's `current_code`; a fresh project (no app / NULL code) is a
    409 "nothing to generate from yet". Bills against the daily gate like a chat turn;
    if a description already exists it is fed in so generation revises it. The result
    is length-capped and stored on the project."""
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

    # Bills like a normal turn: gate BEFORE the model call, 429 with the 5-key body.
    try:
        await enforce_daily_limit(db, user.id)
    except DailyTokenLimitExceededError as exc:
        return exc.as_response()

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
        # 404 rolls the billing back too — an accepted, bounded loss on this rare race
        # (not worth rewiring billing into its own transaction).
        raise AppApiError(status.HTTP_404_NOT_FOUND, "Project not found.") from None
    await db.refresh(project)
    return _to_response(project, app.id, app.status, is_serving=await _serving_now(db, app.id))
