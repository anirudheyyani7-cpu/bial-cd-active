"""`GET /v1/marketplace` — the catalog of published apps, and keyword search over it.

THE ONE READ THAT DELIBERATELY DROPS THE `user_id` PREDICATE — the deviation the v1
router's isolation rule points here to find. An enterprise platform where no app is a
private document, reading a read-only, non-personal catalog, authenticated but not
admin-gated; recorded beside the code it governs because the platform's isolation
rule has no other file to amend. Because the predicate is absent, the exposure surface
is pinned in `MarketplaceEntry` and this module SELECTs those columns explicitly rather
than returning ORM rows.

Membership is DERIVED, never stored: an app is listed while it has a live deployment.
Pagination is by offset, one of the two deviations `pagination.py` names."""

from __future__ import annotations

import math
from typing import Annotated, Any, Literal

import sqlalchemy as sa
from fastapi import APIRouter, Query
from sqlalchemy.orm import aliased

from src.api.deps import CurrentUser, DbSession
from src.api.v1.pagination import (
    DEFAULT_PAGE_SIZE,
    LimitQuery,
    SearchQuery,
    clean_limit,
    clean_search,
)
from src.core.errors import AppApiError
from src.db.models.app_registry import AppRegistry
from src.db.models.deployment import Deployment, DeploymentStatus
from src.db.models.project import DESCRIPTION_TSV_REGCONFIG, Project
from src.db.models.user import User
from src.schemas import AUTH_401, ErrorEnvelope, error_responses
from src.schemas.marketplace import MarketplaceEntry, MarketplaceListResponse
from src.services.deploy.liveness import live_app_ids

router = APIRouter(prefix="/marketplace", tags=["marketplace"])

#: What the browse-order control offers. A closed set, validated rather than defaulted: a
#: typo'd `sort` must 422 rather than quietly returning newest-first, which looks to the
#: caller like the control simply does not work.
Sort = Literal["newest", "name"]

PageQuery = Annotated[int, Query()]
SortQuery = Annotated[
    str | None,
    # The closed set is named in the schema even though the type is `str | None`: validation
    # lives in `clean_sort` so the 422 keeps this platform's `ErrorEnvelope` shape rather
    # than FastAPI's, which means OpenAPI would otherwise advertise a free-form string and a
    # generated client could not see the two legal values.
    Query(description="Browse order. One of: newest (default), name."),
]


# Bounds `(page - 1) * limit` comfortably inside int64 so an absurd page number 422s
# instead of overflowing asyncpg's OFFSET parameter (a raw `DataError: value out of int64
# range` reaching the client as an unhandled 500 — contradicting this route's own "a page
# past the end is empty, not an error" contract). Far beyond any realistic catalog depth.
MAX_PAGE = 100_000


def clean_page(value: int) -> int:
    """Reject an out-of-range `?page=` in the same `{error:{message}}` 422 shape as
    `clean_limit`/`clean_search`.

    Lives here rather than in `pagination.py`: that module is the keyset contract, and an
    offset helper inside it would blur the boundary this endpoint deviates across.
    """
    if not 1 <= value <= MAX_PAGE:
        raise AppApiError(422, f"page must be between 1 and {MAX_PAGE}.")
    return value


def clean_sort(value: str | None) -> Sort:
    """Normalize `?sort=`; absent → `newest`, unrecognized → 422 (never a silent default)."""
    # Each branch RETURNS THE LITERAL rather than the argument. Equality against a string
    # does not narrow `str` to a `Literal` for the checkers, and the alternative — a `cast`
    # over an `in` test — would assert the correspondence instead of demonstrating it.
    if value is None or value == "newest":
        return "newest"
    if value == "name":
        return "name"
    raise AppApiError(422, "sort must be one of: newest, name.")


def _live_catalog(search: str | None) -> tuple[sa.Select[Any], type[Deployment]]:
    """The catalog's membership predicate + the active filter, expressed EXACTLY ONCE.

    Both the page query and the `COUNT(*)` build on this: a total computed over a different
    predicate than the page renders page numbers a reader can click and find empty.

    Returns `(query, deployment)` — `deployment` is the ORM-aliased newest-successful-row-per-app
    entity the query selects from, which callers need for ordering and column selection.
    """
    # MEMBERSHIP IS `live_app_ids()`, NOT A SECOND COPY OF IT. This function used to carry its
    # own `last_unpublished` collapse and its own registry predicates, which is how the
    # catalog could drift into disagreeing with the projects list and the dashboard count
    # about whether an app is live — silently, and only for some apps. `liveness.py` says it
    # answers that question "in one place"; this is what makes the sentence true.
    #
    # `last_success` BELOW STAYS, and it is not a second membership rule: it is the row
    # PROJECTION. The catalog lists a deployment's `url` and its builder, so it needs the
    # actual newest-succeeded row, which a select of `app_id`s cannot give it. Membership
    # decides WHICH apps; this decides WHAT is shown for each.
    last_success = (
        sa.select(Deployment)
        # THE `status` PREDICATE MUST RENDER AS A LITERAL, which is what `literal_execute`
        # buys and a plain `Deployment.status == ...` does not. That renders `status = $1`,
        # and asyncpg prepares server-side against a long-lived pool (`pool_size=20`, no
        # recycle), so from the 6th execution on a connection Postgres plans generically. A
        # generic plan cannot prove `status = $1` implies `ix_deployments_success_collapse`'s
        # `status = 'succeeded'` predicate, so it drops the index and falls back to a Seq
        # Scan — measured at 5.2k apps / 52k rows as 13-15ms for executions 1-5 and 27-30ms
        # from execution 6. `deploy/store.py`'s `_IN_FLIGHT_PREDICATE` renders
        # a literal too, but for a DIFFERENT reason: it is only ever an `index_where=` on an
        # ON CONFLICT, and arbiter inference is a compile-time syntactic match, so it faces
        # no plan-cache risk at all. Same remedy, different cause — neither one is evidence
        # that the other is handled.
        #
        # `literal_execute` rather than that module's `sa.text`: it renders the identical
        # SQL while keeping the value the ENUM, so renaming `SUCCEEDED` moves the predicate
        # with it instead of leaving a string that silently matches nothing.
        #
        # Nothing here fails loudly if this regresses — the answer stays correct and only
        # the plan degrades — so `test_the_success_collapse_predicate_renders_a_literal`
        # pins the compiled SQL.
        .where(
            Deployment.status
            == sa.bindparam("succeeded", DeploymentStatus.SUCCEEDED, literal_execute=True),
            Deployment.url.is_not(None),
        )
        .distinct(Deployment.app_id)
        .order_by(Deployment.app_id, Deployment.id.desc())
        .subquery()
    )
    deployment = aliased(Deployment, last_success, name="last_success")

    query = (
        sa.select(deployment.id)
        .select_from(deployment)
        .join(AppRegistry, AppRegistry.id == deployment.app_id)
        .join(Project, Project.id == AppRegistry.project_id)
        # The builder, for their display name only. INNER join: an app with no owner row is
        # not a catalog entry, it is a data-integrity problem, and it should not be listed.
        # `User.suspended_at` is deliberately NOT filtered: an app stays useful to everyone
        # else when its builder's account is suspended.
        .join(User, User.id == deployment.user_id)
        # The takedown comparison and both registry predicates now live in ONE place. A
        # semi-join, so Postgres still uses the same two partial indexes (migration 0034).
        # A container torn down outside the platform still reads `succeeded` and stays
        # listed; nothing sweeps settled rows, and admin unpublish is the correction.
        .where(AppRegistry.id.in_(live_app_ids()))
    )
    if search is not None:
        query = query.where(Project.description_tsv.op("@@")(_tsquery(search)))
    return query, deployment


def _tsquery(search: str) -> sa.Function[Any]:
    return sa.func.websearch_to_tsquery(DESCRIPTION_TSV_REGCONFIG, search)


def _entry(row: sa.Row[Any]) -> MarketplaceEntry:
    # `row._tuple()`, not attribute access — but be precise about what that buys: on an
    # `Any`-parameterised `Row`, `_tuple()` is itself typed `Any`, so NEITHER the arity nor
    # the order below is checked statically; swapping two same-typed columns in
    # `with_only_columns` passes mypy clean.
    #
    # What it does buy is still worth having, and it is runtime + tests rather than types:
    # an arity change raises a loud `ValueError` here instead of a silent `AttributeError`
    # at attribute-access time, and a reorder is caught by
    # `test_a_signed_in_user_sees_an_app_built_by_someone_else`. The order here must match
    # `with_only_columns`'s order exactly.
    name, description, display_name, url = row._tuple()
    return MarketplaceEntry(
        name=name,
        description=description,
        builder_display_name=display_name,
        url=url,
    )


@router.get(
    "",
    responses=error_responses(
        AUTH_401, (422, ErrorEnvelope, "Invalid page, limit, sort, or over-long q")
    ),
)
async def list_marketplace(
    user: CurrentUser,
    db: DbSession,
    page: PageQuery = 1,
    limit: LimitQuery = DEFAULT_PAGE_SIZE,
    q: SearchQuery = None,
    sort: SortQuery = None,
) -> MarketplaceListResponse:
    """Every currently-published app, or those whose description matches `q`.

    `user` is required but unused, and that is the point: the caller must be a signed-in
    BIAL user, and beyond that the catalog is the same for everyone. RELEVANCE OUTRANKS
    `sort` WHILE SEARCHING — with `q` set the order is `ts_rank_cd` descending, whatever
    `sort` says. A page past the end returns an empty `items` with the real `total`, not
    a 404.
    """
    page = clean_page(page)
    limit = clean_limit(limit)
    search = clean_search(q)
    order = clean_sort(sort)

    # COUNT over the same predicate as the page — see `_live_catalog`. A fresh call, not a
    # shared query object: each call to `_live_catalog` builds its own independent collapse
    # subqueries, so the COUNT and the page can never accidentally share (and corrupt) state.
    count_query, _ = _live_catalog(search)
    total = await db.scalar(sa.select(sa.func.count()).select_from(count_query.subquery()))
    total = int(total or 0)

    catalog, deployment = _live_catalog(search)
    query = catalog.with_only_columns(
        Project.name,
        Project.description,
        User.display_name,
        deployment.url,
    )

    if search is not None:
        # Rank first; `id` breaks ties so a page boundary cannot interleave two runs of the
        # same query differently.
        query = query.order_by(
            sa.func.ts_rank_cd(Project.description_tsv, _tsquery(search)).desc(),
            deployment.id.desc(),
        )
    elif order == "name":
        # `lower()` makes the ordering COLLATION-INDEPENDENT rather than case-insensitive
        # per se. Under this database's `en_US.utf8` it changes nothing — that collation
        # already sorts linguistically, so a bare `ORDER BY name` gives the same answer, and
        # no test can tell the two apart here. Under `C` collation it would matter: byte
        # ordering puts every capital ahead of every lowercase, so "Zebra" would sort before
        # "apple". Kept so the answer does not depend on how a database was initialised.
        query = query.order_by(sa.func.lower(Project.name).asc(), deployment.id.desc())
    else:
        query = query.order_by(deployment.id.desc())

    rows = (await db.execute(query.offset((page - 1) * limit).limit(limit))).all()

    return MarketplaceListResponse(
        items=[_entry(row) for row in rows],
        page=page,
        page_size=limit,
        total=total,
        total_pages=max(1, math.ceil(total / limit)),
    )
