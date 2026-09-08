"""Fixtures shared by every v1 API surface.

`building` lives here rather than under `conversations/` because the gate it exercises is
consulted from more than one surface. It was written when one of those was the legacy
`POST /v1/claude` relay; that relay is retired, but the fixture is still shared by the
conversations, projects and build-sessions suites, so it stays at the level they have in
common. A fixture parked next to one consumer is how the others end up untested.
"""

from __future__ import annotations

import contextlib
import uuid
from collections.abc import Callable, Iterator

import pytest

from src.api.v1.build_sessions.deps import session_manager_dependency
from src.services.build_sessions import SessionManager
from src.services.build_sessions.manager import BuildSession
from src.services.sandbox import SandboxHandle


@pytest.fixture
def building(
    app,
) -> Iterator[Callable[[uuid.UUID, uuid.UUID], contextlib.AbstractContextManager[None]]]:
    """Register a genuinely live build session against a conversation, so the routes' ONE gate
    ("is the agent working in this thread right now?") answers through the REAL
    `SessionManager.live_session_for_conversation` rather than a stub of it.

    Hand-built rather than started for real: what these tests exercise is the ROUTE's refusal,
    and a real start would drag in Redis, a sandbox, and a brain to prove a lookup.

    ★ EVERY TEST THAT USES THIS FIXTURE IS FALSE-GREEN, AND KNOWINGLY SO. It passes a
    `conversation_id` into `BuildSession`, and PRODUCTION CAN NO LONGER MAKE A SESSION OF THAT
    SHAPE AT ALL: the one construction site that ever set the field was `_start_locked`, which is
    deleted, and `ensure_sandbox` — now the only allocator — has never set it. So the field is
    always `None` on a real session, `SessionManager.live_session_for_conversation` can never
    match, and the gate in `api/v1/conversations/turns.py` that calls it is structurally inert.
    These tests go on passing against a shape only this fixture can build; their green says the
    LOOKUP is wired correctly, and says nothing whatever about the gate firing in production.
    The gate is kept as a redesign seam (thread `conversation_id` through `ensure_sandbox` and it
    becomes live for the first time) — see `live_session_for_conversation`'s own docstring in
    `services/build_sessions/manager.py`, which carries the matching warning. Nothing is
    unguarded meanwhile: `turns.py` also asks `conversation_is_mid_reply` and
    `active_session_for`."""
    manager = SessionManager()
    app.dependency_overrides[session_manager_dependency] = lambda: manager

    @contextlib.contextmanager
    def _live(conversation_id: uuid.UUID, user_id: uuid.UUID) -> Iterator[None]:
        session = BuildSession(
            session_id=uuid.uuid7(),
            user_id=user_id,
            project_id=uuid.uuid4(),
            app_id=uuid.uuid4(),
            prompt="build it",
            lock_token="tok",
            handle=SandboxHandle(
                fqdn="x.example",
                token="t",
                app_name="sbx-x",
                preview_url="https://x.example/",
                ready=False,
            ),
            conversation_id=conversation_id,
        )
        manager._sessions[session.session_id] = session
        manager._active_by_user[user_id] = session.session_id
        try:
            yield
        finally:
            manager._sessions.pop(session.session_id, None)
            manager._active_by_user.pop(user_id, None)

    yield _live
