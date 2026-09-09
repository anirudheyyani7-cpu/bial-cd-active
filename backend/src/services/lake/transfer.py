"""The copy nobody reads: a window's parquet files, verbatim, in Redis, under a hard budget.

WHY THIS EXISTS AT ALL, stated once so nobody later mistakes it for a cache. The client asked for
the window's files to be transferred into Redis. Nothing on this platform reads them: the build
agent never sees a row, the generated app reads the lake DIRECTLY with its own identity, and no
route, service or worker in this tree opens one of these keys. So this path must never fail a
build, never block one, and never take space that the store's real job needs — and every decision
below follows from those three sentences rather than from what a cache would want.

EXACTLY TWO THINGS EVER REMOVE A COPY, AND NO THIRD MECHANISM IS BUILT.

1. **Age** — a 7-day TTL on every key. Redis expires them itself, lazily on access and through its
   own background sampling. There is no reaper, no scheduled task and no worker involvement:
   writing one would be re-implementing a guarantee the store already gives.
2. **Size** — the budget below, which is what actually bounds this under load. At any real volume
   the cap bites long before a week passes, which is what makes the longer TTL free rather than
   risky.

NOTHING HERE TOUCHES `maxmemory` OR `maxmemory-policy`, and that will look like the obvious fix to
the next reader. It is not. Every other family in this namespace is either TTL'd or untimed, so
any `volatile-*` policy would evict a live build's LOCK before it evicted a parquet copy — the
trim has to be our own code walking our own index, against our own absolute number.

EVERY COMMAND IS SINGLE-KEY. Production's Azure Managed Redis reports `EnterpriseCluster`: it
reads as unclustered and the database beneath IS sharded, so a multi-key command (an `MGET`, a Lua
script spanning keys, a `MULTI` over two families) is rejected cross-slot in production and cannot
be reproduced on a dev Redis. `locks.py` states the same constraint for the same reason.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, replace
from hashlib import sha256
from typing import Final

import redis.asyncio as aioredis
import structlog
from redis.exceptions import RedisError

from src.services.lake.client import LakeClient
from src.services.lake.errors import LakeError
from src.services.lake.window import SelectedFile, WindowSelection
from src.services.redis.keys import lake_file_key, lake_index_key

_log = structlog.get_logger()

# SEVEN DAYS, enforced by Redis itself. Long enough that the cap is what actually bounds this, and
# short enough that a quiet deployment does not hold a month of parquet it never read.
LAKE_COPY_TTL_SECONDS: Final = 7 * 24 * 60 * 60

# A HARD 300 MB CEILING ON THIS FEATURE'S OWN KEYS. Deliberately NOT sized against the instance:
# its SKU and its co-tenants are unrecorded, and budgeting against an unknown denominator is
# exactly how an earlier draft talked itself into claiming 900 MB of a store it had never
# measured. An absolute cap on our own data needs no such knowledge.
#
# CONSEQUENCE, STATED ONCE SO NOBODY LATER "FIXES" IT: a worst-case window is near 120 MB, so a
# third project's transfer can evict the first project's files. Nothing reads them, so this is not
# a failure — it means the copy holds RECENT FILES, not every project's window.
LAKE_COPY_BUDGET_BYTES: Final = 300 * 1024 * 1024

# The member format in the index: `{size}:{digest}`. The size rides the member so the total is
# DERIVED by summing what is actually indexed, rather than kept in a counter that drifts away from
# the thing it counts. A digest is fixed-width hex and a size is digits, so the split is exact.
_MEMBER_SEPARATOR: Final = ":"


def _digest(blob_name: str) -> str:
    """The key discriminator for one blob name. See `lake_file_key` for why it is hashed."""
    return sha256(blob_name.encode()).hexdigest()


def _member(file: SelectedFile) -> str:
    return f"{file.size}{_MEMBER_SEPARATOR}{_digest(file.name)}"


def _as_text(raw: object) -> str | None:
    """One index member, as text, whatever the client handed back.

    `zrange` is typed as returning members OR `(member, score)` pairs OR nested lists, because one
    method serves `withscores` and `bylex` too; and this feature reads through the BINARY client,
    so a member arrives as `bytes`. Both facts are narrowed here rather than at each call site.

    Members are `{digits}:{hex}` — pure ASCII by construction — so the encode/decode round trip is
    exact, which is what lets a decoded member be handed straight back to `ZREM`."""
    if isinstance(raw, bytes):
        return raw.decode("ascii", errors="ignore")
    return raw if isinstance(raw, str) else None


def _split_member(member: str) -> tuple[int, str] | None:
    """`(size, digest)` from an index member, or `None` for one this code did not write.

    Total rather than raising: the index is shared state in a store other deployments also use,
    and one unreadable member must not stop the trim from freeing the ones it can read."""
    size, separator, digest = member.partition(_MEMBER_SEPARATOR)
    if not separator or not size.isdigit() or len(digest) != 64:
        return None
    return int(size), digest


@dataclass(frozen=True, slots=True)
class TransferReport:
    """What one transfer did — returned for logs and tests, never for a caller to act on.

    `already_held` is the whole-window skip: every file this window selected was already in the
    store, so nothing was downloaded. `skipped_stubs` is carried through from the selection —
    days inside the window that the upstream load left as zero-byte files."""

    copied: int
    bytes_copied: int
    already_held: bool
    skipped_stubs: int
    evicted: int
    too_large_to_hold: int


async def _indexed_total(redis: aioredis.Redis) -> int:
    """The byte total, DERIVED by summing the index rather than read from a counter.

    A counter and the thing it counts drift; a sum cannot. One `ZRANGE` on one key, which is
    single-key and therefore safe on a sharded instance.

    IT CAN OVER-COUNT, AND THAT IS THE SAFE DIRECTION. A file key can expire on its own TTL while
    its index member survives to the index's own (refreshed) expiry, so a total may include bytes
    Redis has already reclaimed. The consequence is that the trim frees slightly more than it had
    to. The opposite error — under-counting, and so exceeding the budget — is impossible, because
    a member is only ever removed by the trim that also deletes its file."""
    total = 0
    for raw in await redis.zrange(lake_index_key(), 0, -1):
        member = _as_text(raw)
        parsed = None if member is None else _split_member(member)
        if parsed is not None:
            total += parsed[0]
    return total


async def _evict_oldest(redis: aioredis.Redis) -> int:
    """Drop the OLDEST-COPIED file. Returns the bytes freed, or 0 when the index is empty.

    THE KEY SELECTION IS THE BLAST RADIUS, and it is derived from a member this code wrote — never
    from a `SCAN`, never from a prefix glob, never from `KEYS`. A widened selection here would
    reach a live build's lock, its heartbeat, its lease, its start marker, the registry hash that
    is the sole input to the fleet sweep, or the taskiq stream. `test_transfer.py` seeds all six
    and asserts they survive a trim at and over budget."""
    oldest = await redis.zrange(lake_index_key(), 0, 0)
    if not oldest:
        return 0
    member = _as_text(oldest[0])
    if member is None:
        # A member shape no client of ours could have produced, and one a `ZREM` cannot NAME.
        # Dropped BY RANK instead — because leaving it is not the harmless move it looks like:
        # the caller's loop re-reads the total and evicts again until the incoming file fits, so
        # a member that can never be removed makes the trim spin forever inside a detached task
        # that nothing is watching. It names no key, so there is nothing else to do with it.
        await redis.zremrangebyrank(lake_index_key(), 0, 0)
        return 0
    await redis.zrem(lake_index_key(), member)
    parsed = _split_member(member)
    if parsed is None:
        # A member no reader of ours wrote — another deployment sharing this instance, or a
        # format that has since changed. Removing it from the index is right (it was occupying
        # an ordering slot, and the loop above must be able to make progress past it), but there
        # is no key it names, so nothing else happens.
        return 0
    size, digest = parsed
    await redis.delete(lake_file_key(digest))
    return size


async def _hold(redis: aioredis.Redis, file: SelectedFile, payload: bytes) -> None:
    """Write one file: the index member FIRST, then the bytes.

    THE ORDER IS THE CRASH BEHAVIOUR, and it is chosen so a half-write errs SAFE. Dying between
    the two leaves a member with no file, which over-counts the total — the trim frees a little
    more than it needed to. The reverse order would leave bytes nothing accounts for, and the
    budget would be quietly exceeded by exactly that much until the key expired.

    Both carry the same TTL, and the index's is REFRESHED on every write: an index that outlives
    what it points at is the ADR-0029 defect in miniature. A re-copy of the same file re-scores
    the same member rather than adding a second — the member is derived from the size and the
    name, so it is stable."""
    await redis.zadd(lake_index_key(), {_member(file): time.time()})
    await redis.expire(lake_index_key(), LAKE_COPY_TTL_SECONDS)
    await redis.set(lake_file_key(_digest(file.name)), payload, ex=LAKE_COPY_TTL_SECONDS)


async def transfer_window(
    lake: LakeClient,
    redis: aioredis.Redis,
    selection: WindowSelection,
) -> TransferReport:
    """Copy every file `selection` chose into Redis, verbatim, within the budget.

    `redis` MUST be the binary client (`get_redis_bytes()`). The ordinary one decodes replies, and
    decoding a parquet file is silent corruption of the one thing this feature copies verbatim.

    NEWEST FIRST, because that is the order the selection arrives in and it is the order that
    matters if the budget runs out mid-window: what gets left behind should be the oldest day.
    """
    report = TransferReport(
        copied=0,
        bytes_copied=0,
        already_held=False,
        skipped_stubs=selection.skipped,
        evicted=0,
        too_large_to_hold=0,
    )
    if not selection.files:
        return report

    missing: list[SelectedFile] = []
    for file in selection.files:
        if not await redis.exists(lake_file_key(_digest(file.name))):
            missing.append(file)
    if not missing:
        # THE WHOLE-WINDOW SKIP (the owner's ruling: skipped when the same files are already
        # held). Checked per file rather than with a marker key, so a PARTIALLY copied window is
        # never claimable as held — which is what makes a mid-window failure self-healing on the
        # next birth rather than a permanent hole.
        return replace(report, already_held=True)

    copied = 0
    bytes_copied = 0
    evicted = 0
    too_large = 0
    for file in missing:
        if file.size > LAKE_COPY_BUDGET_BYTES:
            # Refused BEFORE any eviction. Emptying the whole family to make room for something
            # that still would not fit is the worst available outcome: the budget ends up spent
            # on nothing.
            _log.warning(
                "lake_copy_file_exceeds_the_whole_budget",
                name=file.name,
                size=file.size,
                budget=LAKE_COPY_BUDGET_BYTES,
            )
            too_large += 1
            continue
        while (await _indexed_total(redis)) + file.size > LAKE_COPY_BUDGET_BYTES:
            freed = await _evict_oldest(redis)
            if freed == 0 and not await redis.zcard(lake_index_key()):
                # Nothing left to evict and it still does not fit. Unreachable given the check
                # above, and it is here so the loop cannot spin.
                break
            evicted += 1
        payload = await lake.download(file.name)
        await _hold(redis, file, payload)
        copied += 1
        bytes_copied += len(payload)

    return TransferReport(
        copied=copied,
        bytes_copied=bytes_copied,
        already_held=False,
        skipped_stubs=selection.skipped,
        evicted=evicted,
        too_large_to_hold=too_large,
    )


async def transfer_window_or_log(
    lake: LakeClient,
    redis: aioredis.Redis,
    selection: WindowSelection,
) -> TransferReport | None:
    """`transfer_window`, with every failure swallowed and logged.

    THE ONE DELIBERATE EXCEPTION TO THIS TREE'S "CONFIGURED AND BROKEN ALWAYS RAISES" RULE, and
    the reason is the module docblock's first paragraph: nothing reads this copy, so a citizen
    must never lose a build to it. A raise here would propagate out of a detached task and, at
    best, be logged by its done-callback anyway.

    Returns `None` when it failed — a caller that wants to say "the copy did not happen" can, and
    no caller has to."""
    try:
        return await transfer_window(lake, redis, selection)
    except (LakeError, RedisError) as exc:  # fmt: skip  # ruff py314 strips parens
        _log.warning("lake_copy_failed", error=type(exc).__name__, files=len(selection.files))
        return None
