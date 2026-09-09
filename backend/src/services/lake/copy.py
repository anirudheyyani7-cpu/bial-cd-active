"""The seam between a build starting and a window's files reaching Redis.

ONE FUNCTION THE BUILD PATH CALLS, and it answers the whole question for itself: is a lake
configured, is this connector switched on for this project, has its owner been approved, which
dates does it read, which files are those, and are they already held. Every one of those has an
answer meaning "do nothing", and every one of them returns quietly.

IT OPENS ITS OWN SESSION AND OWNS ITS OWN LIFETIME. It runs as a detached task fired after a
container is born, so by the time it reads the database the request that started it may be long
finished — borrowing that request's session would use it after `get_db` had already rolled it
back. Same rule the deploy pipeline follows.

IT NEVER BLOCKS A BUILD AND NEVER FAILS ONE. Nothing on this platform reads what it writes (the
generated app reads the lake directly, with its own identity), so a citizen must never wait on it
and must never lose a build to it. Every failure is logged and swallowed — the one deliberate
exception to this tree's "configured and broken always raises" rule, stated here and in
`transfer.py` so it reads as a decision rather than a missing `raise`.

WHY IT FIRES ON A BIRTH AND NOT ON EVERY TURN. A container gets its environment exactly once, at
birth; the attach arm is the steady state and forwards none. Firing here on every turn would list
the lake once per message for a copy nobody reads.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Final

import sqlalchemy as sa
import structlog
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.connectors import CONNECTORS, resolve_window
from src.db.models.project import Project
from src.db.models.project_connector import ProjectConnector
from src.services.connectors.access import current_access
from src.services.lake.client import get_lake
from src.services.lake.transfer import TransferReport, transfer_window_or_log
from src.services.lake.window import select_files
from src.services.redis.client import RedisNotConfiguredError, get_redis_bytes

_log = structlog.get_logger()

# Every detached copy in flight, held so the event loop cannot garbage-collect a running task —
# `asyncio.create_task` keeps only a weak reference. Same shape the deploy service uses.
_in_flight: Final[set[asyncio.Task[None]]] = set()


async def _window_for(
    db: AsyncSession, *, user_id: uuid.UUID, project_id: uuid.UUID, connector_key: str
) -> ProjectConnector | None:
    """This project's stored connector row, or `None` when it was never switched on.

    Scoped by the owning `user_id` through a join on `projects` in the SAME `WHERE` clause —
    `project_connectors` carries no user column of its own, so `projects` is its ownership anchor
    and the predicate IS the isolation boundary."""
    row: ProjectConnector | None = await db.scalar(
        sa.select(ProjectConnector)
        .join(Project, Project.id == ProjectConnector.project_id)
        .where(
            ProjectConnector.project_id == project_id,
            ProjectConnector.connector_key == connector_key,
            Project.user_id == user_id,
        )
    )
    return row


async def copy_window_for_project(
    db: AsyncSession, *, user_id: uuid.UUID, project_id: uuid.UUID
) -> TransferReport | None:
    """Copy every connector's current window for this project into Redis. Never raises.

    Returns the LAST connector's report, or `None` when nothing was copied — for logs and tests.
    There is one connector in the registry today; iterating is what keeps a second one from
    needing a change here.
    """
    lake = get_lake()
    if lake is None:
        return None  # no lake configured — the supported dev/test posture
    try:
        redis = get_redis_bytes()
    except RedisNotConfiguredError:
        return None  # no Redis configured — likewise; a build still provisions

    report: TransferReport | None = None
    for connector_key, connector in CONNECTORS.items():
        access = await current_access(db, user_id=user_id, connector_key=connector_key)
        stored = await _window_for(
            db, user_id=user_id, project_id=project_id, connector_key=connector_key
        )
        window = resolve_window(connector, stored, access.request_status)
        # `effectively_on` IS the conjunction (the switch AND the approval), read off the resolver
        # rather than spelled again here. A second place that decides whether a connector reads is
        # a second place that can disagree with the rail the citizen is looking at.
        if window is None or not window.effectively_on:
            continue
        listing = await lake.list_files()
        selection = select_files(listing, window, max_files=connector.max_window_days)
        report = await transfer_window_or_log(lake, redis, selection)
        if report is not None:
            _log.info(
                "lake_window_copied",
                connector=connector_key,
                project_id=str(project_id),
                copied=report.copied,
                bytes_copied=report.bytes_copied,
                already_held=report.already_held,
                # The days inside the window the upstream load left as zero-byte stubs. "The lake
                # was quiet" and "the lake was broken" are different sentences, and with no
                # top-up this number is the only trace of the second.
                unreadable_days=report.skipped_stubs,
                evicted=report.evicted,
            )
    return report


async def _copy_in_its_own_session(user_id: uuid.UUID, project_id: uuid.UUID) -> None:
    from src.db.base import async_session_factory

    try:
        async with async_session_factory() as session:
            await copy_window_for_project(session, user_id=user_id, project_id=project_id)
    except Exception:
        # The outermost catch on a detached task. `transfer_window_or_log` already swallows the
        # lake's and Redis's own failures; this covers the rest — a database blip, a listing that
        # raised — and it is broad on purpose: an exception escaping here would surface as an
        # un-retrieved task exception at garbage-collection time, attributed to nothing.
        _log.exception("lake_window_copy_failed", user_id=str(user_id), project_id=str(project_id))


def schedule_window_copy(user_id: uuid.UUID, project_id: uuid.UUID) -> None:
    """Fire the copy and return immediately. Never raises, never awaits, never blocks a build.

    Called from the sandbox BIRTH arms only — see the module docblock for why not on attach."""
    task = asyncio.create_task(
        _copy_in_its_own_session(user_id, project_id), name="lake-window-copy"
    )
    _in_flight.add(task)
    task.add_done_callback(_in_flight.discard)
