"""The session→record seam, composed (003-U5/U6).

`test_outcome.py` calls `write_build_outcome` directly, which proves the writer. It cannot prove
the SEAM: that a real end sequence on a real `SessionManager` actually threads the session's
thread id, its settled snapshot verdict and its terminal status into that writer. Every link
there is a plain assignment, and a plain assignment is exactly the kind of thing that gets
dropped in a refactor while every unit test stays green (`mocks-mask-composition-seams` learning).

So this drives the REAL SessionManager → REAL end sequence → REAL `write_build_outcome`, with
only the sandbox faked (it needs a container), and asserts the outcome lands in the real thread.
Includes the scripted-failure half: a run that FAILS must still leave a record saying so.

WHAT THE DELETION TOOK, and what it did not. The half of the seam that ran from the START BODY's
`conversationId` through `manager.start` and onto the session is GONE with that route — nothing
sets `BuildSession.conversation_id` any more (`ensure_sandbox` builds its session without it, and
the field's own comment in `manager.py` says so). The half from the SESSION into the record is
live, is the half `_record_outcome` owns, and is what these tests now pin: the thread id is
placed on the session the way the start path placed it, and everything below that seam runs
untouched.
"""

from __future__ import annotations

import asyncio

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.v1.build_sessions.schemas import BuildSessionStatus, PreviewReadyEvent
from src.db.models.conversation import ChatKind, Conversation
from src.db.models.message import Message, MessageEntryKind
from src.services.build_sessions import BuildSession
from tests.api.v1.build_sessions.conftest import a_live_session
from tests.factories import ConversationFactory, MessageFactory, ProjectFactory, UserFactory
from tests.fakes import write_legacy_build_started

PREVIEW = "https://sbx-abc.westeurope.azurecontainerapps.io/"


async def _thread(db_session: AsyncSession):
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    conv = await ConversationFactory.create(
        db_session, user.id, project_id=project.id, kind=ChatKind.BUILD
    )
    # The turn that asked for the build — the outcome must land AFTER it.
    await MessageFactory.create(db_session, user.id, conv.id, seq=0)
    return user, project, conv


async def _session_in_thread(wire, db_session: AsyncSession, user, project, conv) -> BuildSession:
    """A live session that knows which thread it belongs to.

    `conversation_id` is set here rather than by the allocator because there is no allocator
    that sets it any more — `_start_locked`, the one place that ever did, is deleted. The field
    itself is kept (`manager.py` documents it as always `None` in production), and it is the
    input `_record_outcome` reads, so a test that wants the record written supplies it exactly
    as the start path did."""
    session = await a_live_session(wire, db_session, user, project.id)
    session.conversation_id = conv.id
    return session


async def _end_the_session(
    wire,
    session: BuildSession,
    *,
    status: BuildSessionStatus,
    reason: str,
    preview_url: str | None = PREVIEW,
) -> None:
    """Drive the session's real end sequence to the given verdict.

    `stop` is the surviving door into `_end` → `_finalize` → `_do_finalize` → `_record_outcome`,
    and its `reason` is what the terminal status is derived from (`_terminal_status`): anything
    but `build_failed` ends ENDED. A `preview_url` is carried the way a live run carries one —
    a `preview_ready` frame through `on_progress` — so the record's URL comes from the session's
    own state rather than from an argument handed straight to the writer."""
    if preview_url is not None:
        await wire.manager.on_progress(session, PreviewReadyEvent(seq=1, preview_url=preview_url))
    await wire.manager.stop(session, wire.sbx, reason=reason)
    assert session.status is status, f"expected {status}, got {session.status}"


async def _build_parts(db_session: AsyncSession, conversation_id) -> list[dict]:
    """The build-OUTCOME records only (`meta.kind == 'build_outcome'`, the same predicate the
    outcome probes use). The hidden `build_started` marker (U5) is deliberately excluded —
    these tests prove the verdict record, and the marker has its own suite."""
    rows = await db_session.scalars(
        select(Message).where(Message.conversation_id == conversation_id).order_by(Message.seq)
    )
    return [
        m.meta
        for m in rows
        if m.entry_kind is MessageEntryKind.SYSTEM_EVENT
        and isinstance(m.meta, dict)
        and m.meta.get("kind") == "build_outcome"
    ]


async def test_a_finished_build_records_itself_in_its_thread(
    db_session, wire, fake_redis, fake_storage
) -> None:
    user, project, conv = await _thread(db_session)

    session = await _session_in_thread(wire, db_session, user, project, conv)
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    parts = await _build_parts(db_session, conv.id)
    assert len(parts) == 1
    # The seam: the session's thread id reached the END sequence. Every link is a plain
    # assignment — this is the only test that would notice one going missing.
    assert parts[0]["sessionId"] == str(session.session_id)
    assert parts[0]["status"] == "ended"
    assert parts[0]["previewUrl"] == PREVIEW


async def test_a_failed_build_still_records_what_happened(
    db_session, wire, fake_redis, fake_storage
) -> None:
    """The scripted-failure half: a failure is exactly when a user most needs the record, so it
    must not be the path that quietly writes nothing."""
    user, project, conv = await _thread(db_session)

    session = await _session_in_thread(wire, db_session, user, project, conv)
    await _end_the_session(
        wire,
        session,
        status=BuildSessionStatus.FAILED,
        reason="build_failed",
        preview_url=None,
    )

    parts = await _build_parts(db_session, conv.id)
    assert len(parts) == 1
    assert parts[0]["status"] == "failed"
    assert parts[0]["reason"] == "build_failed"
    assert parts[0]["previewUrl"] is None


async def test_the_record_reports_the_session_apis_snapshot_verdict_not_brains_claim(
    db_session, wire, fake_redis, fake_storage
) -> None:
    """R7, carried into the record: `snapshotCommitted` must be the value the end sequence
    settled AFTER its own snapshot step, never a value that predates it — anything read before
    the snapshot could only ever report `false`. Recording that would tell a user their work was
    lost when it was saved a moment later.

    The session starts with `snapshot_committed` false, exactly as it is before finalize runs;
    `_do_finalize`'s step 1 is what flips it, and the record must carry the flipped value."""
    user, project, conv = await _thread(db_session)

    session = await _session_in_thread(wire, db_session, user, project, conv)
    assert session.snapshot_committed is False  # nothing has been pushed yet
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    parts = await _build_parts(db_session, conv.id)
    assert parts[0]["snapshotCommitted"] is True


async def test_the_outcome_lands_after_the_turn_that_asked_for_it(
    db_session, wire, fake_redis, fake_storage
) -> None:
    """Ordering, end to end: the asking turn, then the hidden lifecycle marker, then the verdict.

    The marker is written by `write_legacy_build_started` rather than by the platform, because
    the production writer is deleted — but rows of that shape are PERMANENT in real transcripts
    and the projection still reads them, so the record still has to land after one."""
    user, project, conv = await _thread(db_session)

    session = await _session_in_thread(wire, db_session, user, project, conv)
    await write_legacy_build_started(
        db_session,
        user_id=user.id,
        conversation_id=conv.id,
        session_id=session.session_id,
        started_seq=0,
    )
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    rows = list(
        await db_session.scalars(
            select(Message).where(Message.conversation_id == conv.id).order_by(Message.seq)
        )
    )
    assert [m.seq for m in rows] == [0, 1, 2]
    assert rows[1].meta is not None and rows[1].meta["kind"] == "build_started"
    assert rows[2].meta is not None and rows[2].meta["kind"] == "build_outcome"


async def test_a_wedged_outcome_write_still_lets_the_terminal_fire(
    db_session, wire, fake_redis, fake_storage, monkeypatch
) -> None:
    """The outcome write is the only step in the end sequence that opens a DB session, and it runs
    BEFORE the terminal frame. A wedged connection there would hang every SSE feed without `[DONE]`
    and leave the session un-evictable — so the record is time-bounded and the terminal wins."""
    import src.services.build_sessions.manager as manager_module

    async def _never_returns(*args, **kwargs):
        await asyncio.sleep(3600)

    monkeypatch.setattr(manager_module, "write_build_outcome", _never_returns)
    monkeypatch.setattr(manager_module, "_OUTCOME_WRITE_TIMEOUT_SECONDS", 0.05)
    user, project, conv = await _thread(db_session)

    session = await _session_in_thread(wire, db_session, user, project, conv)
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    live = wire.manager.get(session.session_id)
    assert live is not None
    assert live.status is BuildSessionStatus.ENDED  # the terminal fired regardless
    assert live.terminal_emitted is True
    assert await _build_parts(db_session, conv.id) == []  # …and the record was simply skipped


async def test_a_build_with_no_thread_records_nothing_and_still_ends(
    db_session, wire, fake_redis, fake_storage
) -> None:
    """A session that names no conversation has no transcript to write to — that is a no-op, not
    an error, and the session must still reach its terminal.

    This is now EVERY session production can create, not an API-only edge case: `conversation_id`
    is never set outside a test, so `_record_outcome`'s first line is the branch every real end
    sequence takes. All the more reason it must not be able to raise."""
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)

    session = await a_live_session(wire, db_session, user, project.id)
    assert session.conversation_id is None  # the shape the live allocator hands back
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    live = wire.manager.get(session.session_id)
    assert live is not None
    assert live.status is BuildSessionStatus.ENDED


# --- kind is fixed at creation, an ending never touches it ----------------------------------
#
# THIS SECTION USED TO PROVE A MODE-RESTORE HANDOFF: `Build it` flipped the thread's
# three-valued `mode` to WRITE, Write was a chat dead end, and the end sequence had to hand
# the mode back so the composer could reopen. That whole mechanism — `ConversationMode`, the
# entry-mode round trip through `manager.start`, and the restore-on-finish step — is retired
# (`manager.py`'s own `_do_finalize`/Write-end docstring: "Write is no longer a dead end the
# thread has to be rescued from — that was the whole point of the convergence", predating even
# this enum collapse). `Conversation.kind` is chosen once at creation and never changes (R14/R15;
# no route mutates it), so there is nothing left to restore. `_live_write_thread` and the old
# `_run_to_terminal`, the two helpers that drove that round trip, were deleted rather than
# type-patched: they called `manager.start(..., entry_mode=...)`, a method that no longer exists
# at all, so "fixing" their types would have kept dead, non-callable code alive. What remains
# is the inertness guard: an ordinary ending must leave `kind` exactly as it found it.


async def test_an_api_only_build_never_touches_the_kind(
    db_session, wire, fake_redis, fake_storage
) -> None:
    """The end sequence must never touch `kind` — it is immutable after creation, so a session
    has no mode to flip and nothing to restore."""
    user, project, conv = await _thread(db_session)
    starting_kind = conv.kind

    session = await _session_in_thread(wire, db_session, user, project, conv)
    await _end_the_session(wire, session, status=BuildSessionStatus.ENDED, reason="completed")

    reloaded = await db_session.get(Conversation, conv.id)
    assert reloaded is not None and reloaded.kind is starting_kind
