"""#183 — `POST /v1/build-sessions` and the TWO 409s it can answer.

`reclaim_blocked_response`'s docstring promises that "all three entry points (the send, the
plan offer's build action, and relaunch) come through this one function — which is what makes
the answer identical on all three rather than correct on the one that was tested". `start_build`
did not: it caught `BuildSessionConflictError` and let `SandboxReclaimBlockedError` escape as an
unhandled 500, so the hand-over dialog's own preflight crashed on one of the three doors. These
tests hold the two 409s apart and keep the neighbouring arms (404 / 422 / 503) out of the new
one's reach.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from pydantic_ai import BinaryContent
from pydantic_ai.messages import ModelRequest, UserPromptPart
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.v1.build_sessions.deps import (
    run_build_dependency,
    sandbox_or_none_dependency,
)
from src.db.models.attachment import Attachment
from src.db.models.conversation import ChatKind
from src.main import create_app
from src.services.build_sessions.appdata import resolve_app_for_project
from src.services.build_sessions.manager import _RESTORE_ATTEMPTS, app_name_for
from src.services.messages.store import dump_for_row
from src.services.sandbox.base import SandboxError, SandboxHandle
from src.services.storage import attachment_key, recovery_key, snapshot_key
from tests.api.v1.build_sessions.conftest import BlockingBrain, auth_headers, drain
from tests.factories import ConversationFactory, MessageFactory, ProjectFactory, UserFactory
from tests.fakes import FakeBrain, FakeSandboxClient


async def _start(client: AsyncClient, user, project, **extra: Any):
    body: dict[str, Any] = {"projectId": str(project.id), "prompt": "build me an app"}
    body.update(extra)
    return await client.post("/v1/build-sessions", json=body, headers=auth_headers(user))


async def _hand_the_slot_to(
    db: AsyncSession, store, sbx: FakeSandboxClient, user, project
) -> uuid.UUID:
    """Make `project` the incumbent: a READY registry naming ITS container, an attachable
    handle, and a recovery bundle so the workspace is not the "nothing to lose" case.

    Seeded through the fake's own `restore_from_snapshot`, not by hand-writing the hash — that
    is the call which hydrates the C5 registry in production, so this cannot drift out of the
    shape `_refuse_if_reclaim_would_destroy_work` reads.
    """
    app_id = await resolve_app_for_project(db, user.id, project.id)
    await db.commit()
    handle = await sbx.restore_from_snapshot(
        str(user.id), app_name_for(app_id), app_env={}, source_key=None
    )
    sbx.attach_handle = handle  # the guard attaches to ASK; a fake that refuses reads as a ghost
    key = recovery_key(app_id)
    await store.put(key, b"RECOVERY-BUNDLE")
    # `FakeStorage.head` reads `last_modified` off `mtimes`; without one the bundle is invisible
    # and the guard would be answering a different question than this test asks.
    store.mtimes[key] = datetime.now(UTC)
    return app_id


# --- the two 409s, held apart ------------------------------------------------


async def test_a_slot_held_by_another_project_answers_start_with_the_handover_409(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """#183 — THE unit. A start whose workspace is occupied by a different project is a
    hand-over question, not a crash.

    The body is asserted field by field because the dialog is built from it: without
    `projectName` there is a blank where the other project's name goes, and without `building`
    the client cannot tell "save or switch" from "stop the build first"."""
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user = await UserFactory.create(db_session, email="sc-handover@rvaiglobal.com")
    project_a = await ProjectFactory.create(db_session, user.id)
    project_b = await ProjectFactory.create(db_session, user.id)
    await _hand_the_slot_to(db_session, fake_storage, wire.sbx, user, project_a)

    resp = await _start(client, user, project_b)

    assert resp.status_code == 409  # not the 500 this route used to answer
    body = resp.json()["error"]
    assert body["code"] == "sandbox_reclaim_blocked"
    assert body["projectId"] == str(project_a.id)
    assert body["projectName"] == project_a.name
    assert body["dirty"] is True  # committed work, nothing ever saved
    assert body["building"] is False  # nobody is mid-build in there — Save/Switch, not "stop"
    assert body["agentWorking"] is False
    assert project_a.name in body["message"]
    # The refusal cost project A nothing and project B nothing: no teardown, no new container.
    assert wire.sbx.torn_down == []
    assert wire.sbx.provisioned == []


async def test_a_second_build_for_the_same_project_is_still_the_bare_conflict(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """The two 409s are NOT collapsed. A user's own running build is a different condition with
    a different remedy — wait or stop it — and its body carries `sessionId`, which the hand-over
    dialog would render as a nameless project."""
    brain = BlockingBrain()
    wire.app.dependency_overrides[run_build_dependency] = lambda: brain
    user = await UserFactory.create(db_session, email="sc-samep@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    first = await _start(client, user, project)
    assert first.status_code == 201
    sid = first.json()["sessionId"]

    second = await _start(client, user, project)

    assert second.status_code == 409
    err = second.json()["error"]
    assert err["code"] == "build_session_already_active"
    assert err["sessionId"] == sid
    assert "projectId" not in err  # the hand-over shape never leaks onto this arm

    brain.release()
    await drain(wire.manager, sid)


# --- the neighbouring arms, one assertion each ------------------------------


async def test_an_unknown_conversation_is_still_404(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user = await UserFactory.create(db_session, email="sc-404@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    resp = await _start(client, user, project, conversationId=str(uuid.uuid7()))

    assert resp.status_code == 404


async def test_an_unusable_attachment_is_still_422(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user = await UserFactory.create(db_session, email="sc-422@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    conv = await ConversationFactory.create(
        db_session, user.id, project_id=project.id, kind=ChatKind.BUILD
    )
    key = attachment_key(user.id, uuid.uuid7())
    await fake_storage.put(key, b"definitely not a png", content_type="image/png")
    db_session.add(
        Attachment(
            user_id=user.id,
            attachment_id="sc-img",
            media_type="image/png",
            name="chart.png",
            size=20,
            storage_key=key,
        )
    )
    await db_session.flush()
    await MessageFactory.create(
        db_session,
        user.id,
        conv.id,
        seq=0,
        payload=dump_for_row(
            [
                ModelRequest(
                    parts=[
                        UserPromptPart(
                            content=[
                                "build from these",
                                BinaryContent(
                                    data=b"\x89PNGx", media_type="image/png", identifier="sc-img"
                                ),
                            ]
                        )
                    ]
                )
            ]
        ),
    )

    resp = await _start(client, user, project, conversationId=str(conv.id))

    assert resp.status_code == 422


@pytest.fixture
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Spend the restore's bounded-retry backoff instantly."""
    slept: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr("src.services.build_sessions.manager._asleep", fake_sleep)
    return slept


async def test_a_restore_that_never_completes_is_still_503(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire, no_sleep
) -> None:
    """`SnapshotUnavailableError` — the user's saved version is intact and a retry is the way
    forward. It must never be swallowed by a 409 about a workspace nobody is holding."""

    class DoomedRestore(FakeSandboxClient):
        attempts = 0

        async def restore_from_snapshot(
            self, user_id, app_name, *, app_env, source_key=None
        ) -> SandboxHandle:
            type(self).attempts += 1
            raise SandboxError("npm install failed under set -e")

    doomed = DoomedRestore()
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    wire.app.dependency_overrides[sandbox_or_none_dependency] = lambda: doomed
    user = await UserFactory.create(db_session, email="sc-503@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"BUNDLE")

    resp = await _start(client, user, project)

    assert resp.status_code == 503
    # WHICH 503: this route answers the same copy for an unconfigured sandbox, and that arm
    # never reaches the restore. The exhausted retry budget is the proof we took the arm the
    # new `except` sits next to rather than one it could never have shadowed.
    assert DoomedRestore.attempts == _RESTORE_ATTEMPTS


# --- the contract the route publishes ---------------------------------------


def test_openapi_declares_both_409_shapes_on_start() -> None:
    """The declaration is half the fix. A route documenting only `{message, code, sessionId}`
    tells every generated client that the hand-over fields do not exist — which reproduces
    #183's defect one layer up, in the clients rather than the server."""
    spec = create_app().openapi()
    ref = spec["paths"]["/v1/build-sessions"]["post"]["responses"]["409"]["content"][
        "application/json"
    ]["schema"]["$ref"]
    assert ref.endswith("/BuildConflictEnvelope")
    assert (
        ref
        == (
            spec["paths"]["/v1/build-sessions/relaunch"]["post"]["responses"]["409"]["content"][
                "application/json"
            ]["schema"]["$ref"]
        )
    ), "start and relaunch answer through one helper; they must publish one shape"
    variants = spec["components"]["schemas"]["BuildConflictEnvelope"]["properties"]["error"][
        "anyOf"
    ]
    assert {v["$ref"].rsplit("/", 1)[-1] for v in variants} == {
        "_ConflictError",
        "ReclaimBlockedError",
    }
    reclaim = spec["components"]["schemas"]["ReclaimBlockedError"]["properties"]
    assert {"projectId", "projectName", "dirty", "building", "agentWorking"} <= set(reclaim)
