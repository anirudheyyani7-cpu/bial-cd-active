"""The reaper: reconcile-on-start + the full sweep.

Two entry points, plus `src/workers/sandbox_reap.py`, the scheduled caller of
`sweep_all`:

* `reconcile_user` reaps the caller's OWN stale lock/registry/heartbeat at the top of
  every `start` — closes the "crashed tab -> can never start again" lockout.
* `sweep_all` reconciles EVERY registered user, idempotent + concurrency-safe; runs on
  a schedule, or by hand at `POST /v1/build-sessions/internal/reap`.
* `reap_the_container_we_judged` is the janitor's, keyed by CONTAINER NAME rather than
  user, because a user's record can name a different container by the time the delete
  lands. See its own docstring.

A COMPLETED build is not torn down: the registry stays with a bounded stay-of-execution
lease and the lock releases. `sweep_all` honours an unexpired lease; `reconcile_user`
reaps through one — the incoming build needs the slot. The sweep only reaches containers
with a Redis registry record; one whose record is gone is invisible here forever
(`inventory.take_sandbox_inventory`, `POST /v1/admin/apps/reconcile-sandboxes`, reports
rather than deletes).

WHY THIS EXISTS. The live-session shield (`has_live_session`) reads an IN-PROCESS set,
blind on a second replica — it bit in the quiet stretches between heartbeat renews. A
wall-clock LIVENESS LEASE, renewed every turn, closed that for the sweep;
`certified_dead` still asserts single-replica, and no worker may ever pass it
(`test_no_worker_module_may_certify_death`)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime

import redis.asyncio as aioredis
import structlog

from src.services.build_sessions.durable_copy import CopyVerdict, confirm_durable_copy
from src.services.build_sessions.integrity import container_state
from src.services.build_sessions.locks import (
    delete_registry,
    heartbeat_is_alive,
    liveness_lease_is_held,
    lock_is_held,
    mark_registry_ending,
    read_registry,
    read_starting_marker,
    reap_lock,
    release_liveness_lease,
    stay_of_execution_is_current,
)
from src.services.build_sessions.snapshot import RecoveryOutcome, write_recovery_copy
from src.services.redis import registry_scan_patterns
from src.services.redis.keys import REGISTRY_FIELD_APP_NAME, REGISTRY_FIELD_FQDN
from src.services.sandbox import SandboxClient, SandboxError, SandboxHandle
from src.services.sandbox.base import SANDBOX_NAME_PREFIX

_log = structlog.get_logger()

#: `app_name_for` mints `sbx-` + `app_id.hex[:28]`. Both halves are pinned here because the guard
#: below is a fail-closed check on a name we are about to DELETE, and a guard that accepts more
#: than the minter produces is a guard with a gap in it.
_NAME_SLUG_LENGTH = 28
_HEX_LOWER = frozenset("0123456789abcdef")


async def _scan_the_registry_namespace(redis: aioredis.Redis) -> AsyncIterator[str]:
    """SCAN-iterate every registry pattern the namespace currently spans (never `KEYS`).

    Plural while the namespace spans both the current prefix and the legacy one. This only makes
    the legacy keys REACHABLE — the read that rescues them is the dual-read inside
    `locks.read_registry`, because this loop hands on a user id, not a record.
    """
    for pattern in registry_scan_patterns():
        async for raw_key in redis.scan_iter(match=pattern):
            yield str(raw_key)


def _user_from_registry_key(key: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(key.rsplit(":", 1)[-1])
    except ValueError:
        return None


def _handle_named(app_name: str, *, fqdn: str = "") -> SandboxHandle:
    """The minimal teardown handle — ACA delete is keyed by `app_name` alone; `fqdn` is carried
    when known, left empty otherwise, and read by nothing on the teardown path.

    `preview_url` is EMPTY rather than composed from `fqdn`: composing it used to produce
    `https:///` whenever `fqdn` was absent, and teardown never shows this to a browser, so no
    value is the honest one.
    """
    return SandboxHandle(
        fqdn=fqdn,
        token="",
        app_name=app_name,
        preview_url="",
        ready=False,
    )


def _minimal_handle(reg: dict[str, str]) -> SandboxHandle:
    """The same handle, reconstructed from a registry record — the shape `reap_user` tears down."""
    return _handle_named(
        reg.get(REGISTRY_FIELD_APP_NAME, ""), fqdn=reg.get(REGISTRY_FIELD_FQDN, "")
    )


def is_a_sandbox_name(app_name: str) -> bool:
    """Could this string be a container THIS platform minted? (`manager.app_name_for`.)

    THE LAST CHECK BEFORE AN ARM DELETE. The reap path rebuilds its teardown target from a
    registry record that can be corrupted or missing — `reg.get(APP_NAME, "")` turns a missing
    field into a delete request for `""`. So the shape is checked, not assumed: `sbx-` + exactly
    28 lowercase hex. `pub-` names are citizens' live published apps and the resource group holds
    unrelated workloads; none are ours to delete on a corrupted hash's say-so. Not a prefix test
    alone — `startswith("sbx-")` would pass `sbx-` by itself."""
    if not app_name.startswith(SANDBOX_NAME_PREFIX):
        return False
    slug = app_name[len(SANDBOX_NAME_PREFIX) :]
    return len(slug) == _NAME_SLUG_LENGTH and all(c in _HEX_LOWER for c in slug)


@dataclass(frozen=True)
class _Reachable:
    """The container we are judging: attached, and whatever it said about itself.

    The HANDLE is carried, never re-derived: the registry is the one input that can change under
    us, and a second read could bundle a builder's freshly started sandbox — the WRONG tree —
    into this app's recovery slot. `head` and `uncommitted` are both `None` when the probe did
    not answer, and are separate fields because a head alone conflates "nothing changed" with
    "nothing was COMMITTED", so a gate reading only the head would destroy uncommitted work as
    preserved. `confirm_durable_copy` refuses `None` rather than guessing."""

    handle: SandboxHandle
    head: str | None
    uncommitted: bool | None


async def _reach_the_container(
    sandbox_client: SandboxClient, user_uuid: uuid.UUID
) -> _Reachable | None:
    """Attach to this user's container and ask it for its `HEAD`. `None` if it cannot be asked.

    THE GATE IS ONLY A GATE IF THIS RUNS. `confirm_durable_copy` reads `None` as "unreachable, so
    a parseable recovery bundle stands in" — the fallback for a dead orphan. Pass `None`
    UNCONDITIONALLY instead and that fallback becomes the only reachable branch: the `STALE`
    comparison is dead code, and work newer than the last autosave reads as preserved and dies.
    Uses the ladder `project_save_state` answers with (`attach_existing`, then `container_state`)
    — a reaper must not hold a second opinion about what HEAD means."""
    try:
        handle = await sandbox_client.attach_existing(str(user_uuid))
    except SandboxError:
        # Gone, ending, unreachable, or its bearer unrecoverable — every one of them means "this
        # container cannot be asked anything", which is precisely the case the fallback is for.
        return None
    state = await container_state(sandbox_client, handle)
    return _Reachable(
        handle=handle,
        head=state.head if state is not None else None,
        # BOTH FIELDS COME FROM THE SAME PROBE, so a state that did not answer leaves both
        # unknown rather than leaving `uncommitted` looking like a confident "clean".
        uncommitted=state.uncommitted if state is not None else None,
    )


async def _take_the_copy_we_promised(
    sandbox_client: SandboxClient,
    *,
    app_id: uuid.UUID,
    verdict: CopyVerdict,
    reached: _Reachable | None,
    expected_name: str,
) -> bool:
    """True when this container may now be reclaimed.

    A copy is TAKEN when the newest durable copy predates the newest change. Both call sites once
    spared, so a failed autosave billed forever behind a log line repeating every fifteen minutes
    and looked, to anyone reading it, like the guard working correctly. This really happened. The
    copy goes through `write_recovery_copy`, not a raw `put`: it promotes only a descendant of the
    copy on record and cannot run against an empty slot or pre-stamp bundle, whose write is kept
    but does NOT authorise the destroy (`UNGUARDED`). Every failing arm SPARES and RECORDS."""
    # IMPORTED HERE, NOT AT MODULE SCOPE, and the reason is weight rather than a cycle. There is
    # no import cycle — `src.workers.reclamation` imports the reaper function-scoped, so nothing
    # closes a loop at module-import time. The weight is real: `pass_history` reaches
    # `src.db.base`, which BUILDS
    # THE ORM ENGINE at import, so a module-level bind puts that (and `src.broker`, by way of
    # `src.workers.reclamation`) behind every import of the reaper — including the cold one
    # `test_the_reaper_imports_without_the_fastapi_app` performs.
    from src.services.build_sessions.pass_history import (
        CopyAttempt,
        record_durable_copy_attempt,
    )

    if verdict.may_destroy:
        # SPLIT ON WHY, not just on the verdict, because `may_destroy` is True for two different
        # facts. One is "the sha comparison ran and the copy matches" — genuinely nothing to take.
        # The other is `confirm_durable_copy`'s deliberate fallback: the container could not be
        # read, so a present, parseable bundle stands in. In that second case NOTHING about
        # currency was established, and recording it as "the durable copy was already current"
        # writes the one row an operator would use to find "we destroyed containers we could not
        # verify" and makes it say the opposite.
        compared = reached is not None and reached.head is not None
        await record_durable_copy_attempt(
            CopyAttempt.NOTHING_TO_COPY if compared else CopyAttempt.UNVERIFIED_FALLBACK
        )
        return True
    if reached is None or reached.handle.app_name != expected_name:
        # NOTHING TO COPY FROM. Either the container would not attach, or — and this is the one
        # worth spelling out — the registry has moved on and the handle we hold names a DIFFERENT
        # container. `attach_existing` builds its handle from the record, so a builder who started
        # a fresh sandbox between the record read and the attach hands us their live container.
        # Bundling that tree into this app's recovery slot would overwrite one app's only copy
        # with another app's work; the guarded write would probably divert it, but "probably
        # caught one layer down" is not a reason to hand it the wrong tree.
        _log.warning(
            "no copy taken: nothing to copy from, so this container is spared again",
            app_id=str(app_id),
            expected=expected_name,
            reached=reached.handle.app_name if reached else None,
        )
        await record_durable_copy_attempt(CopyAttempt.UNREACHABLE)
        return False
    try:
        written = await write_recovery_copy(
            sandbox_client, reached.handle, app_id, taken_at=datetime.now(UTC)
        )
    except Exception:
        # BROAD ON PURPOSE, and it is the fail-CLOSED direction. Every way this can fail — the
        # exec, the bundle, the base64 read-back, the store, bytes that will not parse as a
        # bundle — means the same single thing here: the copy did not land. The arm it takes is
        # the sparing one, which can never destroy anything, so narrowing would buy no safety and
        # would cost the record: an unforeseen exception would escape into `sweep_all`'s per-user
        # handler, end this user's reap, and leave behind exactly the silence this unit removes.
        # `CancelledError` is a `BaseException` and still propagates, so a shutdown still stops
        # the sweep rather than being logged and swallowed.
        _log.exception(
            "no copy taken: the recovery write raised, so this container is spared again",
            app_id=str(app_id),
            app_name=expected_name,
        )
        await record_durable_copy_attempt(CopyAttempt.FAILED)
        return False
    if written.outcome is RecoveryOutcome.DIVERTED:
        # The guarded write refused to promote this tree and preserved it under `divert_key`. It
        # has already raised the pinned "recovery write did not land" alarm with the two shas that
        # explain why, so nothing is re-alarmed here — the container is simply spared, which is
        # the only answer available when the tree in hand cannot be shown to contain the work.
        await record_durable_copy_attempt(CopyAttempt.REFUSED)
        return False
    if written.recorded_head is None:
        # THE COPY LANDED, BUT NO GUARD RAN. There was nothing on record to compare it against, so
        # `write_recovery_copy` took its first-write arm — which is right at a turn boundary,
        # where the container is alive and the tree is the citizen's, and wrong here.
        #
        # A REVERTED CONTAINER HAS EXACTLY THIS SHAPE. An app whose every autosave failed has an
        # empty recovery slot, so a reverted container's empty tree becomes the first copy on
        # record, `recoverable_work` ranks it newest by `last_modified`, and the citizen's next
        # build is restored from the template over their saved app. Then this function would
        # return True and delete the container holding the only real tree.
        #
        # So: keep the copy (it is strictly better than nothing), and spare. A later pass with a
        # comparable copy on record can destroy it properly.
        _log.warning(
            "no guarded copy: this was the first copy on record, so the container is spared",
            app_id=str(app_id),
            app_name=expected_name,
            bundled_head=written.bundled_head,
        )
        await record_durable_copy_attempt(CopyAttempt.UNGUARDED)
        return False
    # WRITTEN, or SKIPPED because the commit step found the slot already holding this exact tree.
    # Both mean the recovery slot now contains what the container contains, which is the fact the
    # gate wanted and could not establish from the outside — and both compared against a real
    # recorded head, which is what makes them evidence rather than an assumption.
    await record_durable_copy_attempt(
        CopyAttempt.COPIED
        if written.outcome is RecoveryOutcome.WRITTEN
        else CopyAttempt.NOTHING_TO_COPY
    )
    return True


async def reap_user(
    redis: aioredis.Redis,
    user_uuid: uuid.UUID,
    sandbox_client: SandboxClient,
    *,
    strict: bool = False,
    app_id: uuid.UUID | None = None,
) -> bool:
    """The ordered reap for ONE user's stale sandbox. Returns True if it reaped.

    `strict` separates "nothing was registered" from "teardown failed". A sweep needs neither
    (fire-and-forget, retried in five minutes); a caller about to ACT does — a still-standing
    container would walk the client back into the refusal `release_project_sandbox` just told it
    was resolved, so `strict=True` re-raises and it can answer 503. Lock + registry are KEPT on
    failure either way. `app_id` opts into the durable-copy gate: `None` suits callers whose
    builder is about to get a fresh container; the unwatched janitor always passes it."""
    reg = await read_registry(redis, user_uuid)
    if reg is None:
        # No sandbox registered — just clear any orphaned lock so a crashed-tab user is
        # never locked out.
        await reap_lock(redis, user_uuid)
        return False
    registered_name = reg.get(REGISTRY_FIELD_APP_NAME, "")
    if not is_a_sandbox_name(registered_name):
        # FAIL CLOSED ON A NAME WE CANNOT VOUCH FOR. Everything below hands this string to an ARM
        # delete, and the record it came from is the least trustworthy input here. Refusing but
        # KEEPING the record would re-refuse every five minutes forever, so the record goes and
        # the container — which is somebody else's if it is anything — is left alone.
        _log.error(
            "refusing to reap: the registry names something that is not a sandbox name",
            user_id=str(user_uuid),
            app_name=registered_name,
        )
        await delete_registry(redis, user_uuid)
        await release_liveness_lease(redis, user_uuid)
        await reap_lock(redis, user_uuid)
        return False
    if app_id is not None:
        # THE REAL HEAD, not a hardcoded `None`. See `_reach_the_container`: a constant `None`
        # here made the gate's fallback its only branch, and the comparison it exists to perform
        # unreachable. A container that will not answer still falls back — it just has to
        # actually not answer first.
        reached = await _reach_the_container(sandbox_client, user_uuid)
        verdict = await confirm_durable_copy(
            app_id,
            container_head=reached.head if reached else None,
            container_dirty=reached.uncommitted if reached else None,
        )
        # AND THEN TAKE THE COPY, rather than sparing on the strength of the
        # verdict alone.
        if not await _take_the_copy_we_promised(
            sandbox_client,
            app_id=app_id,
            verdict=verdict,
            reached=reached,
            expected_name=registered_name,
        ):
            # SPARE AND REPORT — never destroy. The container keeps its lock and registry, so a
            # later pass retries once the store is readable again or a copy has been taken.
            _log.warning(
                "reap refused: this container's work is not provably preserved",
                user_id=str(user_uuid),
                app_id=str(app_id),
                copy_state=str(verdict.state),
                reason=verdict.reason,
            )
            return False
    await mark_registry_ending(redis, user_uuid)  # step 1: guard a concurrent attach
    try:
        await sandbox_client.teardown(_minimal_handle(reg))  # step 2: idempotent teardown
    except SandboxError:
        # Teardown failed — KEEP the lock + registry so a later sweep retries; clearing
        # them now would orphan a still-live container. Not silent (logged).
        _log.exception(
            "reaper teardown failed; leaving state for a later sweep", user_id=str(user_uuid)
        )
        if strict:
            raise
        return False
    await delete_registry(redis, user_uuid)  # registry cleared
    # ...and the liveness lease goes WITH the record it belonged to. Only here, after a
    # teardown that actually succeeded: the failure arm above keeps lock + registry so a
    # later sweep retries, and dropping the lease there would strip the protection off a
    # container that is still standing and may still be building.
    await release_liveness_lease(redis, user_uuid)
    await reap_lock(redis, user_uuid)  # step 3: release the (possibly drifted) lock — LAST
    return True


async def reap_the_container_we_judged(
    redis: aioredis.Redis,
    sandbox_client: SandboxClient,
    *,
    app_name: str,
    user_uuid: uuid.UUID,
    app_id: uuid.UUID,
) -> bool:
    """The ordered reap for ONE container, keyed by NAME. True only when it actually deleted it.

    NOT `reap_user`, which destroys whatever the registry currently names for a user. Keying by
    name keeps the janitor honest across an enumerate-then-delete pass: a sandbox started between
    the two would otherwise be deleted while the judged orphan was spared, and an unregistered
    orphan — the population this exists to collect — reported destroyed with nothing deleted. The
    ARM delete uses the judged name; the user's Redis state is touched ONLY when the registry
    still names it: `mark_registry_ending` -> `teardown` -> `delete_registry` -> `reap_lock`."""
    reg = await read_registry(redis, user_uuid)
    ours = reg is not None and reg.get(REGISTRY_FIELD_APP_NAME) == app_name
    # The container is only reachable THROUGH the registry — `attach_existing` builds its handle
    # from that record — so a container the store no longer claims can be judged on its recovery
    # copy alone. That is the gate's documented fallback, and it still demands a parseable bundle.
    # It is also why no copy can be taken for an unregistered orphan: there is no address to
    # bundle from, and the address we DO have belongs to somebody else's container.
    reached = await _reach_the_container(sandbox_client, user_uuid) if ours else None
    verdict = await confirm_durable_copy(
        app_id,
        container_head=reached.head if reached else None,
        container_dirty=reached.uncommitted if reached else None,
    )
    # AND THEN TAKE THE COPY. The janitor is the caller with nobody watching it.
    if not await _take_the_copy_we_promised(
        sandbox_client,
        app_id=app_id,
        verdict=verdict,
        reached=reached,
        expected_name=app_name,
    ):
        # SPARE AND REPORT — never destroy. Nothing is cleared, so the next pass retries once a
        # copy exists or the store is readable again.
        _log.warning(
            "reclamation refused: this container's work is not provably preserved",
            app_name=app_name,
            user_id=str(user_uuid),
            app_id=str(app_id),
            copy_state=str(verdict.state),
            reason=verdict.reason,
        )
        return False
    if ours:
        await mark_registry_ending(redis, user_uuid)  # step 1: guard a concurrent attach
    try:
        await sandbox_client.teardown(
            _handle_named(app_name, fqdn=(reg or {}).get(REGISTRY_FIELD_FQDN, ""))
        )
    except SandboxError:
        # KEEP whatever state there is so a later pass retries; clearing it now would orphan a
        # container that is still standing. Not silent (logged), and NOT counted as destroyed.
        _log.exception(
            "reclamation teardown failed; leaving state for a later pass", app_name=app_name
        )
        return False
    if ours:
        await delete_registry(redis, user_uuid)
        await release_liveness_lease(redis, user_uuid)
        await reap_lock(redis, user_uuid)  # LAST
    return True


async def reconcile_user(
    redis: aioredis.Redis,
    user_uuid: uuid.UUID,
    sandbox_client: SandboxClient,
    *,
    has_live_session: bool,
    honor_stay: bool = False,
    certified_dead: bool = False,
    app_ids_by_name: Mapping[str, uuid.UUID] | None = None,
) -> bool:
    """Reconcile the user's OWN stale state; True if it reaped. Reaps only when a registry entry
    exists, no live in-process session is held, and the state does not merely LOOK live.

    `honor_stay`, the liveness lease and `certified_dead` are three caller asymmetries, not one
    behaviour with three names; each arm below says what collapsing it would cost.
    `certified_dead` is the sweep's forbidden argument, pinned by
    `test_no_worker_module_may_certify_death`: only a caller under the per-user start lock, on a
    single-replica deploy, holds the facts it asserts."""
    if has_live_session:
        # `run_build` outlives the SSE disconnect, so a multi-minute build whose tab closed
        # over 90 seconds ago still owns a session here and is not reaped mid-flight.
        return False
    if certified_dead:
        # DELETE THE LEASE, do not merely decline to read it — and do it here, above every
        # other arm, so a stray lease is cleared even when there is no registry left to
        # reap. Leaving it would let the background sweep go on sparing a container this
        # call has already certified dead and is about to tear down, and the next build
        # registers a DIFFERENT container under the same user. It would also 409 this same
        # builder's next start until the TTL lapsed — the crashed-tab lockout, reproduced.
        await release_liveness_lease(redis, user_uuid)
    reg = await read_registry(redis, user_uuid)
    if reg is None:
        await reap_lock(redis, user_uuid)  # clear any orphaned lock (no lockout)
        return False
    if not certified_dead and await liveness_lease_is_held(redis, user_uuid):
        # The one liveness input readable from a process that is not running the build.
        # Checked BEFORE the lock/heartbeat pair below because it outranks it in both
        # directions — a live build has lost that pair 90 seconds in, and a dead one leaves
        # it standing for a TTL. A held lease means an agent is making tool calls inside
        # that container right now.
        return False
    if not certified_dead and await read_starting_marker(redis, user_uuid) is not None:
        # THE PRE-ADOPT WINDOW, and the only signal that can cover it. Between the registry hash
        # landing and the container's heartbeat being seeded, the lock/heartbeat pair below is an
        # AND that cannot be satisfied — so a sweep landing mid-cold-start would reap a container
        # this user is seconds away from building in. The marker spans exactly that interval and
        # carries a mandatory TTL, so it stops sparing on its own rather than needing anyone to
        # remember to clear it.
        #
        # BELOW the lease, above the pair, for the same reason the lease sits where it does: a
        # start that has already reached a live turn is answered by the stronger signal first.
        return False
    if (
        not certified_dead
        and await lock_is_held(redis, user_uuid)
        and await heartbeat_is_alive(redis, user_uuid)
    ):
        return False  # looks live + recent (bounded by the heartbeat TTL) — leave it
    if honor_stay and await stay_of_execution_is_current(redis, user_uuid):
        # A relaunched preview holds no lock and renews no heartbeat, so the stay is all that
        # stands between it and the sweep, which passes True. Reconcile-on-start keeps the
        # default and reaps THROUGH an unexpired stay: the incoming build needs the single
        # per-user slot, and sparing the preview there would orphan its own container.
        return False
    return await reap_user(
        redis, user_uuid, sandbox_client, app_id=_owning_app_id(reg, app_ids_by_name, user_uuid)
    )


def _owning_app_id(
    reg: dict[str, str],
    app_ids_by_name: Mapping[str, uuid.UUID] | None,
    user_uuid: uuid.UUID,
) -> uuid.UUID | None:
    """The app id behind this registry record, when the caller supplied the map to resolve it.

    THE UNMATCHED CASE IS A DELIBERATE, NARROW HOLE and is logged rather than hidden. A registry
    record naming a container with no app row describes an app that no longer exists, so there is
    no recovery slot to compare against: the gate would return UNCONFIRMED forever and the
    container would be spared until it was deleted by hand, which is the leak this system exists
    to close."""
    if app_ids_by_name is None:
        return None
    app_id = app_ids_by_name.get(reg.get(REGISTRY_FIELD_APP_NAME, ""))
    if app_id is None:
        _log.info(
            "reaping a registered container with no app row; nothing to preserve, gate skipped",
            user_id=str(user_uuid),
            app_name=reg.get(REGISTRY_FIELD_APP_NAME, ""),
        )
    return app_id


@dataclass(frozen=True)
class SweepResult:
    """One sweep's outcome. `failed` exists so a sweep that reconciled nothing because
    everything threw cannot be read as a sweep that found nothing to do."""

    reaped: int
    failed: int


async def sweep_all(
    redis: aioredis.Redis,
    sandbox_client: SandboxClient,
    *,
    live_users: set[uuid.UUID] | None = None,
    app_ids_by_name: Mapping[str, uuid.UUID] | None = None,
) -> SweepResult:
    """SCAN-iterate the registry namespace (never `KEYS`) and reconcile each user; returns what
    it reaped AND what it could not. Idempotent + concurrency-safe, safe to call on a timer.
    `live_users` are the SessionManager's live in-process sessions — never reaped.

    The scheduled reader of the liveness lease — a lease nothing consults spares nothing. Keeps
    `certified_dead=False`, holding none of the facts certification rests on, and passes
    `honor_stay=True`, since a timer has no reason to kill what the user is still looking at.
    `app_ids_by_name` is FORWARDED: the name->id match happens where the record is read."""
    live = live_users if live_users is not None else set()
    reaped = 0
    failed = 0
    # TWO LITERALS RATHER THAN ONE WILDCARD, deliberately: a single `bial:*:sandbox:registry:*`
    # would match OTHER ENVIRONMENTS' keys and reap their containers. A user with a key under
    # both prefixes is visited twice; `reconcile_user` is idempotent, and `seen` keeps the counts
    # honest anyway.
    seen: set[uuid.UUID] = set()
    async for raw_key in _scan_the_registry_namespace(redis):
        user_uuid = _user_from_registry_key(str(raw_key))
        if user_uuid is None or user_uuid in live or user_uuid in seen:
            continue
        seen.add(user_uuid)
        # ONE USER'S FAILURE IS ONE USER'S FAILURE. Unguarded, the first exception would end
        # the whole cycle and every user later in SCAN order would go unreconciled — silently,
        # because SCAN order is not stable enough for anyone to notice the same victims twice.
        # The reachable case is an ARM throttle: `reap_user`
        # deletes through a blocking ARM poller, and a sweep with real work to do issues
        # enough calls to earn a 429. Cancellation still propagates — a shutdown must stop
        # the sweep, not be logged and swallowed per user.
        try:
            if await reconcile_user(
                redis,
                user_uuid,
                sandbox_client,
                has_live_session=False,
                honor_stay=True,
                app_ids_by_name=app_ids_by_name,
            ):
                reaped += 1
        except Exception as exc:
            failed += 1
            _log.exception(
                "sweep skipped one user; continuing",
                user_id=str(user_uuid),
                error_type=type(exc).__name__,
            )
    # COUNT THE FAILURES, and hand them back. Isolating one user is right; reporting only
    # `reaped` is not — a sweep where EVERY user threw (an expired ACA credential, a
    # subscription-wide throttle) returns 0 and is indistinguishable from a sweep with nothing
    # to do. The operator endpoint would answer 200 `{"reaped": 0}` and write an audit row
    # saying the same, while containers accumulate and bill. The per-user log lines exist but
    # nothing aggregates them.
    return SweepResult(reaped=reaped, failed=failed)
