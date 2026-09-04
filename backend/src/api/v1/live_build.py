"""The shared "is a build session live right now?" guard, used by every destructive
owner-facing route that a concurrent build would race.

Copying a snapshot out from under a live build captures the previous build's bundle — valid
bytes, wrong tree, undetectable by any header check — and deleting a project mid-build destroys
every file change the running turn has not committed yet. The submit service, the deploy route
and `projects.delete_project` all need that one question answered, so it is asked in one place.

SCOPE — read this before reusing the helper. The lock is keyed on the USER and carries no app or
project axis, so a bare `lock_is_held` answers "is this user building ANYTHING?", which is the
wrong question for a per-resource guard: with one app per project and many projects per user,
building project A would 409 a delete of unrelated project B. Callers that own a specific app
pass `app_id` and get the narrow answer, and every current caller does. `app_id` stays optional
for a future caller that genuinely wants the per-user answer, but omitting it is a decision to
justify, not the default.

WHAT THIS GUARD DOES **NOT** COVER — a passing guard is not "no container is serving this app".
A relaunched preview holds no lock, so `lock_is_held` is False exactly when a container is still
serving: this guard returns without refusing and the delete proceeds with the container left
running and serving a deleted project's UI. That gap is STILL OPEN — closing it means reading
the preview's stay of execution and calling sandbox teardown from the delete path, which needs a
`SandboxDep` `delete_project` does not have. It is pinned by
`test_a_relaunched_preview_does_not_block_the_delete_and_is_not_torn_down`; do not mark it
closed because this guard shipped.
"""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import redis.asyncio as aioredis
import structlog
from fastapi import status
from fastapi.responses import JSONResponse

from src.core.errors import AppApiError
from src.schemas import CamelModel
from src.services.redis import build_coordination_or_503, get_redis
from src.services.redis.keys import REGISTRY_FIELD_APP_NAME

if TYPE_CHECKING:  # the runtime import stays lazy, as everywhere else in this module
    from src.services.build_sessions import SandboxReclaimBlockedError

_log = structlog.get_logger()


class ReclaimBlockedError(CamelModel):
    """The blocked-reclaim 409 body: the occupying project, and what is happening inside it."""

    message: str
    code: str
    project_id: str
    project_name: str
    dirty: bool | None  # True = known unsaved work; None = we could not tell
    # `dirty` is null whenever `building` is true, and there it means "not asked" rather than
    # "could not tell": probing a tree mid-write produces an answer true for no instant that
    # matters.
    building: bool
    # Wider than `building` and carried beside it, never folded in: `building` decides WHICH
    # dialog the client renders, `agentWorking` decides what that dialog says is happening now.
    agent_working: bool


class ReclaimBlockedEnvelope(CamelModel):
    """`{"error": {message, code, projectId, projectName, dirty, building, agentWorking}}` — the
    409 a turn, start or relaunch returns when taking the one sandbox slot would destroy another
    project's work.

    Lives in this shared module rather than in one domain router because more than one router
    answers it."""

    error: ReclaimBlockedError


def reclaim_blocked_response(exc: SandboxReclaimBlockedError) -> JSONResponse:
    """Format the blocked-reclaim 409. Every entry point that can raise it comes through here,
    so they cannot drift into differently-worded answers.

    `dirty=None` — we reached the container but it would not answer — reads as unsaved on
    purpose: the copy hedges rather than promising, because claiming work is safe when nobody
    could check is the one wrong answer available here.

    TWO SENTENCES, because only one of the two situations is about saving. A project whose agent
    is mid-build cannot be released until the build stops, so "has unsaved changes" would point
    that user at a Save button the server will refuse."""
    if exc.building:
        message = f"“{exc.project_name}” is still being built."
    else:
        unsaved = "has unsaved changes" if exc.dirty else "may have unsaved changes"
        message = f"“{exc.project_name}” is still open and {unsaved}."
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={
            "error": {
                "message": message,
                "code": "sandbox_reclaim_blocked",
                "projectId": str(exc.project_id),
                "projectName": exc.project_name,
                "dirty": exc.dirty,
                "building": exc.building,
                "agentWorking": exc.agent_working,
            }
        },
    )


async def refuse_while_build_session_live(
    user_id: uuid.UUID,
    *,
    conflict_message: str,
    app_id: uuid.UUID | None = None,
    conflict_code: str | None = None,
) -> None:
    """Raise 409 `conflict_message` while this user has a live build session, 503 when
    Redis cannot say, and return normally otherwise.

    Pass `app_id` to narrow the refusal to a live session building THAT app; omit it for
    the coarse per-user refusal (any live build blocks the action).

    `conflict_code` gives the refusal a stable machine-readable code. Optional because the
    two older callers never had one; the publish route passes it so an agent can tell
    "a build is running, wait and retry" from every other 409 on that endpoint without
    string-matching prose.
    """
    # Lazy import: a module-level `services.build_sessions` import cycles at load time
    # (build_sessions/__init__ → locks → api.build_sessions schemas → its router → deps
    # → back into the half-initialized build_sessions package).
    from src.services.build_sessions import lock_is_held

    with build_coordination_or_503():
        redis = get_redis()
        if not await lock_is_held(redis, user_id):
            return  # nothing is building — proceed
        if app_id is not None and not await _the_live_session_is_this_app(redis, user_id, app_id):
            return  # something IS building, but not this app — proceed
        raise AppApiError(status.HTTP_409_CONFLICT, conflict_message, code=conflict_code)


async def _the_live_session_is_this_app(
    redis: aioredis.Redis, user_id: uuid.UUID, app_id: uuid.UUID
) -> bool:
    """Does the live session the lock represents belong to `app_id`?

    The lock carries no app axis, so the app identity is recovered from the sandbox
    REGISTRY hash, whose `app_name` field is a pure, stable function of the app id
    (`app_name_for`, written by the sandbox client at provision time). Equal name ⇒ the live
    session is this app's.

    FAILS CLOSED, deliberately. "The lock is held but the registry does not resolve to an
    app" is AMBIGUITY, not evidence of innocence, and it has a real cause: `_start_locked`
    takes the lock BEFORE it provisions the container that writes the registry hash, so
    that window reads exactly this way — lock held, registry absent. Proceeding there lets
    the delete land mid-provision, so an unresolvable registry returns True and the caller
    refuses. Only a registry that positively names a DIFFERENT app buys a proceed.

    (A Redis ERROR while reading the registry is not this branch: `read_registry` is bare
    by module policy, so it propagates to `build_coordination_or_503` and becomes a 503 —
    "cannot answer" and "answers something else" stay distinct.)
    """
    from src.services.build_sessions import app_name_for, read_registry

    registry = await read_registry(redis, user_id)
    live_app_name = (registry or {}).get(REGISTRY_FIELD_APP_NAME, "")
    if not live_app_name:
        _log.info(
            "a build lock is held but names no app; refusing rather than racing it",
            user_id=str(user_id),
            app_id=str(app_id),
        )
        return True
    return live_app_name == app_name_for(app_id)
