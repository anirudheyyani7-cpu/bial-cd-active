"""The Redis copy: does it survive the codec, does it stay inside its budget, and can it reach
anything it must not.

THE FIRST TEST IN THIS FILE IS THE ONE THE UNIT WAS WRITTEN AROUND. The platform's Redis client is
built with `decode_responses=True`, which is right for every other family here — locks, heartbeats,
the registry hash, the lease, the start marker — and catastrophic for parquet: a reply is decoded
as UTF-8 before any caller sees it, so a file either raises or comes back as a `str` that
re-encodes to different bytes. That is silent corruption of the one thing this feature copies
verbatim, and it would survive every other assertion in this file.

THE SECOND THING THIS FILE IS FOR IS THE BLAST RADIUS. The trim deletes keys, in a namespace where
a scheduled job reads the registry hash and destroys Azure containers on the strength of it. So
every other family is seeded and asserted to survive a trim at and over budget — all six of them,
because four of six is not a blast-radius test: a bug that reached the start marker or the taskiq
stream would pass it while taking down a live build.

Two clients, one server, exactly as production has it: `fakeredis` with a shared `FakeServer`, a
decoded client for the other families and a binary one for this feature's own keys.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import date

import fakeredis.aioredis
import pytest
import redis.asyncio as aioredis
from redis.exceptions import ConnectionError as RedisConnectionError

from src.core.connectors import ResolvedWindow
from src.db.models.project_connector import ConnectorWindowKind
from src.services.lake.client import LakeClient
from src.services.lake.errors import LakeError
from src.services.lake.transfer import (
    LAKE_COPY_BUDGET_BYTES,
    LAKE_COPY_TTL_SECONDS,
    _digest,
    transfer_window,
    transfer_window_or_log,
)
from src.services.lake.window import SelectedFile, WindowSelection
from src.services.redis.keys import (
    heartbeat_key,
    lake_file_key,
    lake_index_key,
    lease_key,
    lock_key,
    registry_key,
    starting_key,
)

_ROOT = "AOS/tb_flight_fact_report/"
_USER = uuid.UUID("018f3f9c-0000-7000-8000-000000000001")


def _selected(day: int, size: int) -> SelectedFile:
    name = f"{_ROOT}2026/SEPTEMBER/tb_flight_fact_report_202609{day:02d}.parquet"
    return SelectedFile(name=name, size=size, day=date(2026, 9, day))


def _selection(*files: SelectedFile, skipped: int = 0) -> WindowSelection:
    ordered = sorted(files, key=lambda item: item.day, reverse=True)
    return WindowSelection(
        files=tuple(ordered),
        skipped=skipped,
        total_bytes=sum(item.size for item in ordered),
    )


def _window(start: date, end: date) -> ResolvedWindow:
    return ResolvedWindow(
        effectively_on=True,
        kind=ConnectorWindowKind.RELATIVE,
        start=start,
        end=end,
        days=(end - start).days + 1,
        clamped=False,
        earliest=start,
        latest=end,
    )


class _FakeLake:
    """A lake that hands back deterministic bytes for a name, and can be told to fail."""

    def __init__(self, *, raises: Exception | None = None) -> None:
        self.raises = raises
        self.downloaded: list[str] = []
        self.payloads: dict[str, bytes] = {}

    async def download(self, name: str) -> bytes:
        if self.raises is not None:
            raise self.raises
        self.downloaded.append(name)
        return self.payloads.get(name, name.encode() * 4)


def _lake(fake: _FakeLake) -> LakeClient:
    """The fake, typed as the client. `transfer_window` only ever calls `download`."""
    from typing import cast

    return cast("LakeClient", fake)


@pytest.fixture
async def redis_pair() -> AsyncIterator[tuple[aioredis.Redis, aioredis.Redis]]:
    """`(text, binary)` over ONE fake server — the production shape, where two pools address the
    same instance and the same database. Sharing the server is what makes the blast-radius test
    meaningful: keys the decoded client writes are genuinely reachable by the binary one."""
    server = fakeredis.FakeServer()
    text = fakeredis.aioredis.FakeRedis(server=server, decode_responses=True)
    binary = fakeredis.aioredis.FakeRedis(server=server, decode_responses=False)
    yield text, binary
    await text.flushall()
    await text.aclose()
    await binary.aclose()


# --- the codec ----------------------------------------------------------------------------------


async def test_bytes_written_are_bytes_read(redis_pair) -> None:
    """★ THE ASSERTION THE WHOLE UNIT HANGS ON.

    A payload spanning the full 8-bit range: a null byte, a real parquet magic number, a UTF-8
    continuation byte with no lead, and every value from 0 to 255. Written through the binary
    client and read back through it, unchanged. Do this on the decoded client and it raises
    `UnicodeDecodeError` — which is the GOOD outcome; the bad one is a payload that happens to
    decode and re-encodes to something else."""
    _text, binary = redis_pair
    payload = b"PAR1" + bytes(range(256)) + b"\x00\xff\xfe\x80PAR1"
    lake = _FakeLake()
    file = _selected(1, len(payload))
    lake.payloads[file.name] = payload

    await transfer_window(_lake(lake), binary, _selection(file))

    assert await binary.get(lake_file_key(_digest(file.name))) == payload


async def test_the_decoded_client_would_have_mangled_it(redis_pair) -> None:
    """The negative half, so the test above is not merely asserting that a fake round-trips.

    This is what the ordinary platform client does with the same bytes — and it is the reason
    `get_redis_bytes()` exists as a second pool rather than a flag on a call."""
    text, binary = redis_pair
    payload = b"PAR1" + bytes(range(256))
    await binary.set("bial:test:codec-probe", payload)

    with pytest.raises(UnicodeDecodeError):
        await text.get("bial:test:codec-probe")


# --- the happy path -----------------------------------------------------------------------------


async def test_a_window_writes_one_key_and_one_index_entry_per_file(redis_pair) -> None:
    _text, binary = redis_pair
    files = [_selected(day, 4_000) for day in (1, 2, 3)]

    report = await transfer_window(_lake(_FakeLake()), binary, _selection(*files))

    assert report.copied == 3
    assert report.already_held is False
    for file in files:
        assert await binary.exists(lake_file_key(_digest(file.name)))
    assert await binary.zcard(lake_index_key()) == 3


async def test_every_key_carries_the_seven_day_ttl(redis_pair) -> None:
    """★ Age is one of the only two things that removes a copy, and Redis owns it. A key without
    a TTL is one this code can never clean up, in a store nothing here monitors."""
    _text, binary = redis_pair
    file = _selected(1, 4_000)

    await transfer_window(_lake(_FakeLake()), binary, _selection(file))

    assert await binary.ttl(lake_file_key(_digest(file.name))) == LAKE_COPY_TTL_SECONDS
    assert await binary.ttl(lake_index_key()) == LAKE_COPY_TTL_SECONDS


async def test_the_index_ttl_is_refreshed_on_every_write(redis_pair) -> None:
    """An index that outlives what it points at over-counts the budget for as long as it survives.
    Refreshing it on each write keeps it at least as fresh as its newest member."""
    _text, binary = redis_pair
    await transfer_window(_lake(_FakeLake()), binary, _selection(_selected(1, 4_000)))
    await binary.expire(lake_index_key(), 5)

    await transfer_window(_lake(_FakeLake()), binary, _selection(_selected(2, 4_000)))

    assert await binary.ttl(lake_index_key()) == LAKE_COPY_TTL_SECONDS


async def test_the_stub_count_is_carried_through_to_the_report(redis_pair) -> None:
    """Days the window could not read are the selection's finding, not the transfer's, and they
    have to survive the hand-off — they are the only trace a bad stretch leaves."""
    _text, binary = redis_pair

    report = await transfer_window(
        _lake(_FakeLake()), binary, _selection(_selected(1, 4_000), skipped=3)
    )

    assert report.skipped_stubs == 3


# --- the skip -----------------------------------------------------------------------------------


async def test_a_window_already_held_downloads_nothing(redis_pair) -> None:
    """★ The owner's ruling: skipped when the same files are already held. Asserted on the LAKE
    rather than on Redis — the point is that nothing is downloaded, not that nothing is written."""
    _text, binary = redis_pair
    files = [_selected(day, 4_000) for day in (1, 2, 3)]
    lake = _FakeLake()
    await transfer_window(_lake(lake), binary, _selection(*files))
    lake.downloaded.clear()

    report = await transfer_window(_lake(lake), binary, _selection(*files))

    assert report.already_held is True
    assert report.copied == 0
    assert lake.downloaded == []


async def test_a_partly_held_window_copies_only_what_is_missing(redis_pair) -> None:
    """★ AND IS NEVER CLAIMABLE AS HELD. A marker key per window would have said "held" here,
    which is what makes a mid-window failure a permanent hole rather than something the next
    birth heals."""
    _text, binary = redis_pair
    lake = _FakeLake()
    await transfer_window(_lake(lake), binary, _selection(_selected(1, 4_000)))
    lake.downloaded.clear()
    files = [_selected(day, 4_000) for day in (1, 2, 3)]

    report = await transfer_window(_lake(lake), binary, _selection(*files))

    assert report.already_held is False
    assert report.copied == 2
    assert sorted(lake.downloaded) == sorted(
        f.name for f in files[1:] + files[:1] if f.day.day > 1
    )


# --- the budget ---------------------------------------------------------------------------------


async def test_writing_past_the_budget_evicts_the_oldest_copied_file_first(redis_pair) -> None:
    """★ OLDEST-COPIED, not oldest-dated and not whole-window. Eviction is at file granularity
    because a partial copy is exactly as unread as a whole one."""
    _text, binary = redis_pair
    third = LAKE_COPY_BUDGET_BYTES // 3 + 1
    first = _selected(1, third)
    second = _selected(2, third)
    third_file = _selected(3, third)
    lake = _FakeLake()
    lake.payloads = {f.name: b"x" * f.size for f in (first, second, third_file)}
    await transfer_window(_lake(lake), binary, _selection(first))
    await transfer_window(_lake(lake), binary, _selection(second))

    report = await transfer_window(_lake(lake), binary, _selection(third_file))

    assert report.evicted == 1
    assert not await binary.exists(lake_file_key(_digest(first.name))), "the oldest copy goes"
    assert await binary.exists(lake_file_key(_digest(second.name)))
    assert await binary.exists(lake_file_key(_digest(third_file.name)))


async def test_the_trim_stops_as_soon_as_the_incoming_file_fits(redis_pair) -> None:
    """It frees what it needs and no more. A trim that cleared the family to make room would
    throw away copies the client asked for, for nothing."""
    _text, binary = redis_pair
    tenth = LAKE_COPY_BUDGET_BYTES // 10
    lake = _FakeLake()
    held = [_selected(day, tenth) for day in range(1, 11)]
    lake.payloads = {f.name: b"x" * f.size for f in held}
    for file in held:
        await transfer_window(_lake(lake), binary, _selection(file))
    incoming = _selected(11, tenth)
    lake.payloads[incoming.name] = b"x" * tenth

    report = await transfer_window(_lake(lake), binary, _selection(incoming))

    assert report.evicted == 1
    assert await binary.zcard(lake_index_key()) == 10


async def test_a_file_larger_than_the_whole_budget_is_refused_before_anything_is_evicted(
    redis_pair,
) -> None:
    """★ Emptying the family to make room for something that still would not fit is the worst
    available outcome: the budget ends up spent on nothing."""
    _text, binary = redis_pair
    lake = _FakeLake()
    held = _selected(1, 4_000)
    await transfer_window(_lake(lake), binary, _selection(held))
    monster = _selected(2, LAKE_COPY_BUDGET_BYTES + 1)

    report = await transfer_window(_lake(lake), binary, _selection(monster))

    assert report.too_large_to_hold == 1
    assert report.evicted == 0
    assert report.copied == 0
    assert await binary.exists(lake_file_key(_digest(held.name))), "the held copy is untouched"


async def test_the_total_stays_honest_across_repeated_evictions(redis_pair) -> None:
    """★ THE DRIFT TEST. Write far past the budget and the accounted total must equal the sum of
    what is ACTUALLY still stored — not a counter that has wandered away from it.

    It cannot drift here by construction: the total is derived by summing the index, and a member
    is only ever removed by the same trim that deletes its file. That is the property being
    pinned, so a future rewrite to a counter has something to fail."""
    _text, binary = redis_pair
    chunk = LAKE_COPY_BUDGET_BYTES // 8
    lake = _FakeLake()
    for day in range(1, 25):
        file = _selected(day, chunk)
        lake.payloads[file.name] = b"x" * chunk
        await transfer_window(_lake(lake), binary, _selection(file))

    members = await binary.zrange(lake_index_key(), 0, -1)
    accounted = sum(int(m.decode().split(":")[0]) for m in members)
    stored = 0
    for member in members:
        digest = member.decode().split(":")[1]
        payload = await binary.get(lake_file_key(digest))
        stored += len(payload or b"")

    assert accounted == stored
    assert accounted <= LAKE_COPY_BUDGET_BYTES


# --- the blast radius ----------------------------------------------------------------------------


async def test_a_trim_at_and_over_budget_touches_no_other_family(redis_pair) -> None:
    """★ ALL SIX OTHER FAMILIES, not four. A bug that reached the start marker or the taskiq
    stream would pass a four-family test while taking down a live build — and the registry hash is
    the sole input to the sweep that DELETES AZURE CONTAINERS, so losing one strands a container
    permanently.

    The trim runs at the budget and then past it, so both the "nothing to free" and the "free
    repeatedly" paths are exercised against the same seeded neighbours."""
    text, binary = redis_pair
    neighbours = {
        lock_key(_USER): "a-lock-token",
        heartbeat_key(_USER): "2026-09-09T10:00:00+00:00",
        lease_key(_USER): "1789251600.0",
        starting_key(_USER): str(uuid.uuid4()),
    }
    for key, value in neighbours.items():
        await text.set(key, value)
    await text.hset(registry_key(_USER), mapping={"app_name": "sbx-abc", "state": "ready"})
    await text.xadd("bial:test:taskiq:stream", {"task": "a-queued-job"})

    quarter = LAKE_COPY_BUDGET_BYTES // 4
    lake = _FakeLake()
    for day in range(1, 9):
        file = _selected(day, quarter)
        lake.payloads[file.name] = b"x" * quarter
        await transfer_window(_lake(lake), binary, _selection(file))

    for key, value in neighbours.items():
        assert await text.get(key) == value, f"{key} was collateral damage"
    assert await text.hgetall(registry_key(_USER)) == {"app_name": "sbx-abc", "state": "ready"}
    assert await text.xlen("bial:test:taskiq:stream") == 1


async def test_the_lake_keys_sit_outside_the_sandbox_domain(redis_pair) -> None:
    """The prefixes differ at the segment after the environment, which is the earliest place they
    could. A fleet sweep scanning `bial:{env}:sandbox:*` cannot see a parquet copy, and this
    feature's own trim cannot see a container record."""
    from src.services.redis.keys import key_prefix, lake_key_prefix

    assert not lake_index_key().startswith(key_prefix())
    assert not lake_key_prefix().startswith(key_prefix())
    # They agree on everything ABOVE the domain segment and differ from there down, so neither
    # prefix can ever be a prefix of the other however the environment is spelled.
    assert lake_key_prefix().removesuffix("lake:") == key_prefix().removesuffix("sandbox:")


# --- failure ------------------------------------------------------------------------------------


async def test_a_download_failure_part_way_leaves_no_claimable_window(redis_pair) -> None:
    """★ The window must not be claimable as held after a partial copy — the next birth has to
    finish the job rather than skip it."""
    _text, binary = redis_pair
    files = [_selected(day, 4_000) for day in (1, 2, 3)]
    lake = _FakeLake(raises=LakeError("the lake stopped answering"))

    with pytest.raises(LakeError):
        await transfer_window(_lake(lake), binary, _selection(*files))

    healthy = _FakeLake()
    report = await transfer_window(_lake(healthy), binary, _selection(*files))
    assert report.already_held is False
    assert report.copied == 3


async def test_a_lake_failure_is_swallowed_and_logged_by_the_guarded_entry_point(
    redis_pair,
) -> None:
    """★ Nothing reads this copy, so a citizen must never lose a build to it. `None` says the copy
    did not happen; no caller has to look."""
    _text, binary = redis_pair
    lake = _FakeLake(raises=LakeError("the lake refused"))

    assert await transfer_window_or_log(_lake(lake), binary, _selection(_selected(1, 1))) is None


async def test_redis_being_unreachable_is_swallowed_too(redis_pair) -> None:
    """The other half of the same rule, and the one that is easy to miss: a Redis blip on this
    path must not fail the build either."""
    _text, binary = redis_pair
    await binary.aclose()

    class _Dead:
        async def exists(self, *_: object) -> int:
            raise RedisConnectionError("connection refused")

    from typing import cast

    dead = cast("aioredis.Redis", _Dead())
    assert (
        await transfer_window_or_log(_lake(_FakeLake()), dead, _selection(_selected(1, 1))) is None
    )


async def test_an_empty_selection_writes_nothing_and_is_not_an_error(redis_pair) -> None:
    """A window whose days the lake has not loaded is a legitimate product state."""
    _text, binary = redis_pair

    report = await transfer_window(_lake(_FakeLake()), binary, _selection())

    assert report.copied == 0
    assert report.already_held is False
    assert await binary.zcard(lake_index_key()) == 0


async def test_a_member_this_code_did_not_write_cannot_stall_the_trim(redis_pair) -> None:
    """★ THE TRIM MUST ALWAYS MAKE PROGRESS. Production shares one Redis instance with other BIAL
    applications, so a member in an unrecognised format is a thing that can genuinely appear —
    and the eviction loop re-reads the total and evicts again until the incoming file fits. A
    member the trim could not remove would spin that loop forever, inside a detached task nothing
    is watching, on a code path whose failures are deliberately swallowed.

    Asserted with a timeout rather than by inspection, because "it terminates" is the property."""
    _text, binary = redis_pair
    lake = _FakeLake()
    half = LAKE_COPY_BUDGET_BYTES // 2 + 1
    await binary.zadd(lake_index_key(), {"not-a-member-this-code-wrote": 1.0})
    await binary.zadd(lake_index_key(), {f"{half}:{'a' * 64}": 2.0})
    incoming = _selected(9, half)
    lake.payloads[incoming.name] = b"x" * half

    async with asyncio.timeout(10):
        report = await transfer_window(_lake(lake), binary, _selection(incoming))

    assert report.copied == 1
    members = {m.decode() for m in await binary.zrange(lake_index_key(), 0, -1)}
    assert "not-a-member-this-code-wrote" not in members
