"""The Azure-side sandbox inventory — the view the reaper does not have.

WHY THIS EXISTS. `sweep_all` enumerates from Redis, one pass per registered user, so it can only
ever collect a container it already has a record of. A sandbox whose registry entry is gone is
invisible to it FOREVER: the Redis it was registered in was flushed or replaced (every local dev
stack is a different instance), or the container predates the registry hash, or a `reap_user`
teardown failed after `delete_registry` — the one ordering where the record goes first. None of
those are exotic: one container in the dev subscription ran for twelve days at ~$78/month, found
only because a human went looking. For REGISTERED sandboxes the sweep collects automatically; this
module is the other half.

AND WHY IT STAMPS AN AGE AZURE ALREADY REPORTS. Azure publishes `createdAt` and
`systemData.createdAt` for every container and this platform trusts neither: their behaviour
across a delete-and-recreate under the SAME name is undocumented, so neither says how old THIS
container is. Every container provisioned here carries its own creation tag, stamped at birth and
read back off the ARM record — so reading an age costs an ARM listing and a hot path does without.
Backfill covers containers predating that stamping and errs toward WAITING: the age it writes is
`now`, so one reads as brand new and serves its full tier clock. Believing an Azure timestamp
would hand a nineteen-day-old ghost an instant death sentence on evidence already judged untrusted.

REPORT-ONLY, deliberately: an inventory cannot tell "orphaned" from "provisioned four seconds ago
by a start that has not written its registry hash yet". `_start_locked` takes the lock BEFORE it
provisions the container that writes the registry, so that window reads exactly like an orphan.
Telling an operator the names is enough to act; deleting on a guess is not.
"""

from __future__ import annotations

import datetime as dt
import uuid
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import redis.asyncio as aioredis
import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.app_registry import AppRegistry
from src.services.build_sessions.locks import read_registry
from src.services.redis import registry_scan_patterns
from src.services.redis.keys import REGISTRY_FIELD_APP_NAME
from src.services.sandbox.base import (
    KIND_BUILD_SANDBOX,
    TAG_APP_ID,
    TAG_BACKFILLED_AT,
    TAG_CONTROL_PLANE,
    TAG_CREATED_AT,
    TAG_KIND,
    TAG_USER_ID,
    FleetMember,
    SandboxError,
    control_plane_segment,
)

_log = structlog.get_logger()


@runtime_checkable
class FleetLister(Protocol):
    """The one capability this module needs from a control plane. A Protocol rather than the
    concrete `AcaControlPlane` so a test needs no Azure client, and so a future substrate
    (ACA Sandboxes, say) satisfies it by shape. Deliberately NOT added to the `SandboxClient`
    ABC, which is a frozen cross-track contract — the capability lives on the concrete
    client and the route checks for it at runtime.

    ONE ENUMERATION FOR EVERY QUESTION. One method rather than a names-only and a names→tags
    pair walking the same ARM pages: no two callers can hold different beliefs about the fleet,
    and the fleet is walked once per pass rather than once per question. `FleetMember.tags` is
    normalized to `{}` for a container ARM returned with no `tags` key at all: absent FROM the
    list means the container does not exist, an empty `tags` means it exists carrying no
    identity, and the backfill below depends on that difference."""

    async def list_sandbox_fleet(self) -> list[FleetMember]: ...


@runtime_checkable
class FleetTagger(FleetLister, Protocol):
    """`FleetLister` plus the write half: stamp identity tags onto a container.

    TWO PROTOCOLS, NOT ONE, deliberately. `take_sandbox_inventory` above needs only to enumerate,
    and demanding a *stamper* for a read-only report would over-constrain a substrate that can list
    but not write — and would turn every existing listing-only fake into a 503 for no gain. Because
    this extends `FleetLister`, a client that can stamp can always list, which is the direction
    that is actually true.

    `stamp_tags` is a MERGE: it adds and overwrites the keys given and leaves every other tag
    alone. That is a promise the IMPLEMENTATION has to keep, not one ARM keeps for it — the
    `Microsoft.App` provider replaces the whole tag map on a PATCH, so the real client reads
    before it writes. A substrate that cannot honour the merge cannot implement this protocol:
    stamping here destroys identity, and identity is what the classifier judges by."""

    async def stamp_tags(self, *, name: str, tags: dict[str, str]) -> None: ...


@runtime_checkable
class FleetDestroyer(FleetTagger, Protocol):
    """`FleetTagger` plus the one capability only a DESTROY path needs: re-reading a single
    container's tags immediately before acting on it.

    THREE PROTOCOLS, NOT TWO, for the same reason there are two rather than one. The backfill
    lists and stamps and never re-reads; widening `FleetTagger` to demand the capability of it
    503s nine of its tests. Capability protocols earn their keep by being narrow.

    `get_app_tags` returns `None` when ARM says the container does not exist — a DIFFERENT answer
    from `{}` (it exists, carrying no identity). The destroy path depends on the difference:
    absent means the delete already landed; untagged means somebody rewrote the resource and it
    is no longer ours to judge."""

    async def get_app_tags(self, *, name: str) -> dict[str, str] | None: ...


@dataclass(frozen=True)
class SandboxInventory:
    """What ARM has, what the registry claims, and the gap between them.

    `unregistered` is THE LEAK: containers Azure is billing for that nothing tracks, so no sweep
    will ever reach them. `registered_missing` is the opposite and far less urgent — a registry
    entry whose container is already gone, which the next `reconcile_user` clears on its own."""

    live: tuple[str, ...]
    registered: tuple[str, ...]
    unregistered: tuple[str, ...]
    registered_missing: tuple[str, ...]


async def _registered_app_names(redis: aioredis.Redis) -> set[str]:
    """Every app name the sandbox registry currently claims is live.

    Scans through `registry_scan_patterns()` and reads through `read_registry`, which is how the
    sweep does it. Reading the registry any second way would let this function and the sweep
    disagree about what is registered, and a container reported here as `unregistered` is one an
    operator is being told nothing tracks."""
    names: set[str] = set()
    seen: set[uuid.UUID] = set()
    for pattern in registry_scan_patterns():
        async for raw_key in redis.scan_iter(match=pattern):
            try:
                user_uuid = uuid.UUID(str(raw_key).rsplit(":", 1)[-1])
            except ValueError:
                continue  # a key we did not write; not ours to interpret
            if user_uuid in seen:  # the same user under both prefixes — one read is enough
                continue
            seen.add(user_uuid)
            reg = await read_registry(redis, user_uuid)
            app_name = (reg or {}).get(REGISTRY_FIELD_APP_NAME)
            if app_name:
                names.add(app_name)
    return names


async def take_sandbox_inventory(
    redis: aioredis.Redis, control_plane: FleetLister
) -> SandboxInventory:
    """Diff the sandbox containers ARM knows about against the ones the registry claims.

    A listing failure PROPAGATES. A partial inventory that read as "no orphans" would be the
    worst possible output — it is the exact answer that gets a billing container forgotten for
    another twelve days."""
    live = {member.name for member in await control_plane.list_sandbox_fleet()}
    registered = await _registered_app_names(redis)
    return SandboxInventory(
        live=tuple(sorted(live)),
        registered=tuple(sorted(registered)),
        unregistered=tuple(sorted(live - registered)),
        registered_missing=tuple(sorted(registered - live)),
    )


# --- the tag backfill ----------------------------------------------------------------
#
# Every container provisioned since identity stamping shipped carries its identity from birth.
# This is the other half: the containers that already exist. Until they are stamped, the whole
# fleet is un-judgeable without Redis, which is why running this is a RELEASE PREREQUISITE and not
# a follow-up — the destroy flag must not be flipped while the fleet still reports untagged
# sandboxes.


@dataclass(frozen=True)
class TagBackfillReport:
    """What one backfill pass did, in buckets that SUM.

    `scanned == already_tagged + stamped + skipped_no_row + failed`, the `appdb/reconcile.py`
    shape: a report whose buckets do not add up is a report nobody can check, and an operator is
    about to decide whether the fleet is ready for a destructive flag on the strength of it.

    `skipped_no_row` is the bucket that matters most and its name understates it: those containers
    WERE stamped — with `kind` and `backfilled_at` and nothing else — because no app row matched
    their name. They carry no owner, and they will be reported forever and destroyed by nothing.

    `unowned` DELIBERATELY DOES NOT PARTICIPATE IN THE SUM. The four buckets above describe what
    THIS PASS DID; `unowned` describes what the FLEET IS, and an operator needs the second one on
    every pass, not just the first. Without it the escalate-forever population disappears after
    its first stamping: those containers now carry `bial-kind`, so the next pass counts them in
    `already_tagged`, and `already_tagged == scanned` — the endpoint's only clean-fleet signal —
    reads identically for a fully-identified fleet and for one made entirely of containers no
    human has adjudicated. That is the number an operator checks before flipping the destroy
    flag, and it goes quiet exactly when that decision is being made."""

    scanned: int
    already_tagged: int
    stamped: int
    skipped_no_row: int
    failed: int
    unowned: int


async def _app_names_to_owners(db: AsyncSession) -> dict[str, tuple[uuid.UUID, uuid.UUID]]:
    """Map every app's DERIVED sandbox name back to `(app_id, user_id)`.

    FORWARD-MATCHED, never reverse-parsed, and that is the whole safety argument. `app_name_for`
    produces `sbx-` + `app_id.hex[:28]` — 28 of 32 hex characters, truncated to fit ACA's 32-char
    name limit — so a sandbox name does NOT identify its app. Deriving the name for each known app
    and comparing is exact; parsing an owner out of a name is a guess, and a guess here promotes an
    unproven container into the destroy-eligible tiers.

    FLEET-WIDE ON PURPOSE. Every other query in this codebase is scoped by `user_id`; this one
    cannot be, because the question is "does ANY user own this container" and a per-user scope
    would answer "no" for every container belonging to somebody else — turning every other
    citizen's live sandbox into an unowned orphan. It reads two identifier columns and no user
    data, and it is reachable only from a superadmin fleet endpoint, the same posture as the other
    reconcilers.

    `app_name_for` is imported in-function because it lives in `manager`, which pulls in the api
    schema package and pydantic_ai; a module-level import would drag both into every consumer of
    this module — including the out-of-process worker that has no business loading them."""
    from src.services.build_sessions.manager import app_name_for

    rows = (await db.execute(sa.select(AppRegistry.id, AppRegistry.user_id))).all()
    return {app_name_for(app_id): (app_id, user_id) for app_id, user_id in rows}


def _backfill_tags(owner: tuple[uuid.UUID, uuid.UUID] | None) -> dict[str, str]:
    """The tags to merge onto one pre-existing container.

    Two shapes, the difference being the escalate-never-destroy invariant made concrete. Owner
    recovered: full identity, `created_at` set to NOW with a `backfilled_at` marker saying that age
    is synthetic. No matching app row: `kind` and `backfilled_at` and NOTHING ELSE —
    escalate-forever by construction, reported every pass and destroyed by none. Filling in a
    plausible owner is the one change that would silently make it destroy-eligible.
    """
    stamped_at = dt.datetime.now(dt.UTC).isoformat()
    if owner is None:
        return {TAG_KIND: KIND_BUILD_SANDBOX, TAG_BACKFILLED_AT: stamped_at}
    app_id, user_id = owner
    return {
        TAG_KIND: KIND_BUILD_SANDBOX,
        TAG_USER_ID: str(user_id),
        TAG_APP_ID: str(app_id),
        TAG_CONTROL_PLANE: control_plane_segment(),
        TAG_CREATED_AT: stamped_at,
        TAG_BACKFILLED_AT: stamped_at,
    }


async def backfill_sandbox_tags(db: AsyncSession, control_plane: FleetTagger) -> TagBackfillReport:
    """Stamp identity onto every sandbox container that predates identity stamping.

    Idempotent: a container already carrying `bial-kind` is counted and LEFT ALONE. Re-stamping
    would overwrite a real `bial-created-at` with `now` on every run, resetting the age clock of
    the entire fleet each time an operator pressed the button — which would make the feature that
    reclaims idle containers reclaim nothing, forever, while every test stayed green.

    ONE CONTAINER'S FAILURE DOES NOT FAIL THE PASS. A refused PATCH is counted in `failed` and the
    sweep moves on, because the operation is idempotent and the next run retries it; aborting on
    the first failure would leave the fleet part-stamped with no report of what remains.

    AN ENUMERATION FAILURE IS DIFFERENT AND PROPAGATES. A half-listed fleet reporting "nothing left
    to stamp" is the exact false green that the destroy flag is gated on."""
    live = {member.name: member.tags for member in await control_plane.list_sandbox_fleet()}
    owners = await _app_names_to_owners(db)
    # END THE READ TRANSACTION BEFORE THE ARM LOOP. `owners` is already materialised as plain
    # UUIDs, so nothing below needs the session — and what follows is an unbounded serial walk of
    # PATCHes, each pollable to `_LRO_CEILING_SECONDS`. Holding the request's connection
    # idle-in-transaction across all of that starves a small pool for as long as the sweep runs,
    # for no gain at all. The three sibling reconcilers never do external writes under an open
    # session; this is the first endpoint that could, so it explicitly does not.
    #
    # `commit`, not `rollback`, for a transaction that only read: both end it and hand the
    # connection back, but rollback would also discard anything the caller had written before
    # calling us — which is real in the test harness, where the whole test runs inside one
    # transaction, and would be a live foot-gun for any future caller that seeds and then
    # backfills. Ending a read this way costs nothing and cannot destroy anybody's work.
    await db.commit()

    already_tagged = stamped = skipped_no_row = failed = unowned = 0
    for name in sorted(live):
        if live[name].get(TAG_KIND):
            already_tagged += 1
            # A container stamped by an EARLIER pass and still carrying no owner. Counting it
            # only when this pass did the stamping is what made the escalate-forever population
            # vanish on every re-run.
            if not live[name].get(TAG_USER_ID):
                unowned += 1
            continue
        owner = owners.get(name)
        try:
            await control_plane.stamp_tags(name=name, tags=_backfill_tags(owner))
        except SandboxError:
            # The name reaches this log line and nowhere else — the report is counts — so this
            # is an operator's only record of WHICH container refused.
            _log.warning("sandbox_tag_backfill_failed", app_name=name, exc_info=True)
            failed += 1
            continue
        if owner is None:
            _log.warning(
                "sandbox_tag_backfill_found_no_owner",
                app_name=name,
                detail=(
                    "stamped kind + backfilled_at only; no app row matches this name, so the "
                    "container stays escalate-only forever rather than being guessed an owner"
                ),
            )
            skipped_no_row += 1
            unowned += 1
        else:
            stamped += 1

    return TagBackfillReport(
        scanned=len(live),
        already_tagged=already_tagged,
        stamped=stamped,
        skipped_no_row=skipped_no_row,
        failed=failed,
        unowned=unowned,
    )
