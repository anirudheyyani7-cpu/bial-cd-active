"""The duplicate check at project creation (#191 slice 4, R31-R37).

Searches the LIVE MARKETPLACE SET (R32 — exactly `live_app_ids()`, never reimplemented) for
apps that look like the description a citizen just typed, before their project is created.
Built on the same two-arm hybrid shape `api/v1/marketplace/router.py::_hybrid_catalog` uses
for marketplace search, but answers a different question: search asks "rank everything by
relevance", this asks "is any ONE of these confidently the same app" — so it keeps each arm's
OWN NATIVE SCORE (not just its RRF-fused rank) and applies a confidence bar per candidate
(R34) instead of returning a ranked page.

NEVER RAISES (R37): a search or embedding failure here must never be the reason a citizen
cannot start a project, so every failure mode collapses to "no duplicate found".
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import sqlalchemy as sa
import structlog
from pydantic_ai import Embedder
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.app_registry import AppRegistry
from src.db.models.project import DESCRIPTION_TSV_REGCONFIG, Project
from src.db.models.user import User
from src.schemas.marketplace import MarketplaceEntry
from src.services.deploy.liveness import last_success_deployment, live_app_ids

logger = structlog.get_logger()

#: R39's two pinned events — greppable constants, imported rather than retyped, mirroring
#: `core/alarms.py`'s doctrine. Not IN that module: these are not alarms (nothing failed),
#: and both the log site and every test importing them live in this one feature's own
#: package, so the cross-package leaf-module treatment `core/alarms.py` exists for buys
#: nothing here.
DUPLICATE_MATCHES_SHOWN_EVENT = "duplicate_check_matches_shown"
DUPLICATE_CHECK_RESOLVED_EVENT = "duplicate_check_resolved"

MAX_MATCHES = 3
"""R34 — "at most three matches are shown"."""

_CANDIDATE_WINDOW = 10
"""Each arm's own top-N considered for the confidence bar (NOT the marketplace search's
200 — this only ever needs to find up to `MAX_MATCHES` confident matches, not rank a whole
result page)."""

_AGREEMENT_TOP_N = 5
"""Both arms placing a candidate in their OWN top-N is a confident match on its own — no
native-score threshold needed. Tighter than `_CANDIDATE_WINDOW` so "agreement" means a real
top tier in both rankings, not merely "present somewhere in the fetched window"."""

# SINGLE-ARM THRESHOLDS, each in that arm's OWN units — never a fused/RRF score (R34
# forbids a flat fused-score cutoff: "RRF scores are rank-derived with no natural zero").
#
# Cosine similarity is `1 - cosine_distance`, bounded [-1, 1] for normalised embeddings, so
# a threshold here is at least dimensionally meaningful. 0.75 is a commonly-cited "clearly
# related" zone for OpenAI's `text-embedding-3-small` on short text; the ACCEPTANCE EXAMPLE
# this guards (a semantically related but vocabulary-disjoint match must surface) sets the
# floor this cannot be tightened past. NOT measured against this platform's real catalog —
# there is none yet (#191's own Dependencies section: "the marketplace is empty at time of
# build") — so this is the best available prior, not a live calibration, and should be
# revisited once real descriptions exist to tune against.
_VECTOR_SOLO_SIMILARITY = 0.75

# STRICTER — used only when the keyword arm returned NOTHING AT ALL (not merely "didn't
# include this candidate"): with no keyword signal to cross-check against, a lone vector
# match needs to clear a higher bar before it is worth interrupting someone's create flow.
_VECTOR_ONLY_FALLBACK_SIMILARITY = 0.85

# `ts_rank_cd`'s native scale is corpus- and query-length-dependent (no fixed bound the way
# cosine similarity has), so this constant is the least defensible of the three without live
# data — flagged here rather than asserted with false confidence. Tune against real
# descriptions before go-live; a value this low is deliberately permissive in the meantime,
# since the vector arm's own bar is the one carrying most of the recall burden here.
_KEYWORD_SOLO_RANK = 0.01


@dataclass(frozen=True)
class DuplicateCheckResult:
    matches: list[MarketplaceEntry]


def _tsquery(search: str) -> sa.Function[Any]:
    return sa.func.websearch_to_tsquery(DESCRIPTION_TSV_REGCONFIG, search)


async def find_possible_duplicates(
    db: AsyncSession, description: str, embedder: Embedder | None
) -> DuplicateCheckResult:
    """Search the live marketplace catalog for apps that look like `description` (R31),
    before a new project is created. NEVER RAISES — see the module docstring; any internal
    failure is logged and answered as "no duplicate found" rather than propagated.
    """
    try:
        return await _find_possible_duplicates(db, description, embedder)
    except Exception:  # noqa: BLE001 — R37: a failed check must never block a create
        logger.warning("duplicate_check_failed", exc_info=True)
        return DuplicateCheckResult(matches=[])


def _candidate_query(description: str, query_embedding: list[float] | None) -> sa.Select[Any]:
    """Build the candidate query: up to `_CANDIDATE_WINDOW` rows per arm, FULL OUTER joined,
    carrying each arm's own rank AND native score (never a fused RRF score — R34 forbids a
    flat fused-score cutoff), joined onto the display columns `MarketplaceEntry` needs.

    Separated from `_find_possible_duplicates` so the query itself is compile-testable
    without a live database — the same reason `marketplace/router.py::_hybrid_catalog`
    returns a query object rather than executing inline.
    """
    live = live_app_ids()
    kw_rank_expr = sa.func.ts_rank_cd(Project.description_tsv, _tsquery(description)).desc()
    kw_arm = (
        sa.select(
            AppRegistry.id.label("app_id"),
            sa.func.row_number().over(order_by=kw_rank_expr).label("rank"),
            sa.func.ts_rank_cd(Project.description_tsv, _tsquery(description)).label("score"),
        )
        .select_from(AppRegistry)
        .join(Project, Project.id == AppRegistry.project_id)
        .where(
            AppRegistry.id.in_(live),
            Project.description_tsv.op("@@")(_tsquery(description)),
        )
        .order_by(kw_rank_expr)
        .limit(_CANDIDATE_WINDOW)
        .cte("kw_arm")
    )

    if query_embedding is not None:
        vec_distance = Project.description_embedding.cosine_distance(query_embedding)
        vec_arm = (
            sa.select(
                AppRegistry.id.label("app_id"),
                sa.func.row_number().over(order_by=vec_distance).label("rank"),
                (1.0 - vec_distance).label("score"),
            )
            .select_from(AppRegistry)
            .join(Project, Project.id == AppRegistry.project_id)
            .where(
                AppRegistry.id.in_(live),
                Project.description_embedding.is_not(None),
            )
            .order_by(vec_distance)
            .limit(_CANDIDATE_WINDOW)
            .cte("vec_arm")
        )
        candidates = (
            sa.select(
                sa.func.coalesce(kw_arm.c.app_id, vec_arm.c.app_id).label("app_id"),
                kw_arm.c.rank.label("kw_rank"),
                kw_arm.c.score.label("kw_score"),
                vec_arm.c.rank.label("vec_rank"),
                vec_arm.c.score.label("vec_score"),
            )
            .select_from(kw_arm.outerjoin(vec_arm, kw_arm.c.app_id == vec_arm.c.app_id, full=True))
            .cte("candidates")
        )
    else:
        # No embedder configured, or the embed call already raised (caught by the public
        # wrapper) — either way this is only ever called with a real embedding or none at
        # all, never a partial one.
        candidates = (
            sa.select(
                kw_arm.c.app_id.label("app_id"),
                kw_arm.c.rank.label("kw_rank"),
                kw_arm.c.score.label("kw_score"),
                sa.null().label("vec_rank"),
                sa.null().label("vec_score"),
            )
            .select_from(kw_arm)
            .cte("candidates")
        )

    deployment = last_success_deployment()
    return (
        sa.select(
            candidates.c.kw_rank,
            candidates.c.kw_score,
            candidates.c.vec_rank,
            candidates.c.vec_score,
            Project.name,
            Project.description,
            User.display_name,
            deployment.url,
        )
        .select_from(candidates)
        .join(deployment, deployment.app_id == candidates.c.app_id)
        .join(AppRegistry, AppRegistry.id == candidates.c.app_id)
        .join(Project, Project.id == AppRegistry.project_id)
        .join(User, User.id == deployment.user_id)
    )


def _select_confident_matches(rows: Sequence[sa.Row[Any]]) -> list[sa.Row[Any]]:
    """Apply R34's confidence bar to the candidate rows and cap at `MAX_MATCHES` — the pure,
    DB-free half of the duplicate check, so its branching is unit-testable directly against
    hand-built rows rather than only through a live query.

    Each `row` is expected to expose `kw_rank`, `kw_score`, `vec_rank`, `vec_score` (any may
    be `None` — a row absent from an arm never populated it) as its first four positional
    values, matching `_candidate_query`'s column order.
    """
    keyword_arm_is_empty = not any(row.kw_rank is not None for row in rows)
    vector_solo_bar = (
        _VECTOR_ONLY_FALLBACK_SIMILARITY if keyword_arm_is_empty else _VECTOR_SOLO_SIMILARITY
    )

    accepted: list[tuple[int, sa.Row[Any]]] = []
    for row in rows:
        both_in_agreement = (
            row.kw_rank is not None
            and row.kw_rank <= _AGREEMENT_TOP_N
            and row.vec_rank is not None
            and row.vec_rank <= _AGREEMENT_TOP_N
        )
        keyword_alone_clears = (
            row.kw_rank is not None
            and row.kw_score is not None
            and row.kw_score >= _KEYWORD_SOLO_RANK
        )
        vector_alone_clears = (
            row.vec_rank is not None
            and row.vec_score is not None
            and row.vec_score >= vector_solo_bar
        )
        if not (both_in_agreement or keyword_alone_clears or vector_alone_clears):
            continue
        # Best available rank in either arm — ties among confident matches broken by
        # whichever ranking placed the candidate closest to the top, not by arithmetic on
        # two differently-scaled native scores.
        best_rank = min(
            row.kw_rank or _CANDIDATE_WINDOW + 1, row.vec_rank or _CANDIDATE_WINDOW + 1
        )
        accepted.append((best_rank, row))

    accepted.sort(key=lambda pair: pair[0])
    return [row for _, row in accepted[:MAX_MATCHES]]


async def _find_possible_duplicates(
    db: AsyncSession, description: str, embedder: Embedder | None
) -> DuplicateCheckResult:
    query_embedding: list[float] | None = None
    if embedder is not None:
        # R21: "document" on BOTH sides of the duplicate check — this is description-
        # against-description, never a search-box "query" embedding.
        result = await embedder.embed_documents(description)
        query_embedding = list(result.embeddings[0])

    rows = (await db.execute(_candidate_query(description, query_embedding))).all()
    top = _select_confident_matches(rows)

    matches = [
        MarketplaceEntry(
            name=row.name,
            description=row.description,
            builder_display_name=row.display_name,
            url=row.url,
        )
        for row in top
    ]
    return DuplicateCheckResult(matches=matches)


def log_matches_shown(*, project_id_hint: uuid.UUID | None, match_count: int) -> None:
    """R39's first event: how many matches the check surfaced, every time it runs
    (including zero — the day-one, empty-catalog case is itself worth counting, since
    "the check ran and found nothing" is a different fact from "the check never ran")."""
    logger.info(
        DUPLICATE_MATCHES_SHOWN_EVENT,
        match_count=match_count,
        # `None` on create (no project exists yet to hang the event off) — the caller may
        # still correlate by request/session if needed; this is a count, not an audit trail.
        project_id_hint=str(project_id_hint) if project_id_hint is not None else None,
    )


def log_resolution(*, resolution: str) -> None:
    """R39's second event: what the citizen did once shown matches — opened an existing
    app, or created anyway. `resolution` is a plain string rather than an enum import here
    to keep this module independent of the API schema layer; the router validates the
    closed set before calling this."""
    logger.info(DUPLICATE_CHECK_RESOLVED_EVENT, resolution=resolution)
