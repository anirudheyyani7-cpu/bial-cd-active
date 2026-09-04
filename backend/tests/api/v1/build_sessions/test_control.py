"""Build-session control ops: start / stop / status (cookie auth + CSRF, owner-scoping)."""

from __future__ import annotations

import asyncio
import json
import re
import uuid

from fastapi import FastAPI
from httpx import AsyncClient
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.v1.build_sessions.deps import run_build_dependency
from src.services.build_sessions.locks import lock_is_held
from src.services.build_sessions.manager import StopOutcome
from src.services.redis import BUILD_COORDINATION_UNAVAILABLE_MSG
from src.services.storage import StorageError
from tests.api.v1.build_sessions.conftest import (
    BlockingBrain,
    auth_headers,
    drain,
    seed_live_sandbox_state,
)
from tests.factories import ProjectFactory, UserFactory
from tests.fakes import FakeBrain


async def _user_project(db: AsyncSession, email: str):
    user = await UserFactory.create(db, email=email)
    project = await ProjectFactory.create(db, user.id)
    return user, project


async def _no_sleep(_seconds: float) -> None:
    """Collapse the retry backoff so the fail-closed path is tested at full speed."""


async def test_start_happy_returns_201_provisioning(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl1@rvaiglobal.com")
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "build me an app"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["status"] == "provisioning"
    assert body["previewUrl"] is None
    assert body["projectId"] == str(project.id)
    assert uuid.UUID(body["sessionId"]) and uuid.UUID(body["appId"])
    await drain(wire.manager, body["sessionId"])


async def test_start_without_cookie_is_401(
    client: AsyncClient, db_session: AsyncSession, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    resp = await client.post(
        "/v1/build-sessions", json={"projectId": str(uuid.uuid4()), "prompt": "p"}
    )
    assert resp.status_code == 401


async def test_start_without_csrf_is_403(
    client: AsyncClient, db_session: AsyncSession, fake_redis, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl2@rvaiglobal.com")
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user, with_csrf=False),
    )
    assert resp.status_code == 403
    assert resp.json()["error"]["code"] == "csrf_failed"


async def test_start_without_configured_brain_is_503(
    client: AsyncClient, db_session: AsyncSession, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: None
    user, project = await _user_project(db_session, "ctl3@rvaiglobal.com")
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 503  # no `fake_redis`: the refusal lands before any Redis write


async def test_second_start_while_live_is_409_carrying_session_id(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    brain = BlockingBrain()
    wire.app.dependency_overrides[run_build_dependency] = lambda: brain
    user, project = await _user_project(db_session, "ctl4@rvaiglobal.com")
    r1 = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    assert r1.status_code == 201
    sid = r1.json()["sessionId"]
    r2 = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p2"},
        headers=auth_headers(user),
    )
    assert r2.status_code == 409
    err = r2.json()["error"]
    assert err["code"] == "build_session_already_active"
    assert err["sessionId"] == sid
    brain.release()
    await drain(wire.manager, sid)


async def test_status_after_completion_carries_preview_and_last_seq(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl5@rvaiglobal.com")
    r = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    sid = r.json()["sessionId"]
    await drain(wire.manager, sid)
    s = await client.get(f"/v1/build-sessions/{sid}", headers=auth_headers(user))
    assert s.status_code == 200
    body = s.json()
    assert body["status"] == "ended"
    assert body["previewUrl"] == "https://preview.example/"
    assert body["lastSeq"] == 3


async def test_status_of_another_users_session_is_404(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    owner, project = await _user_project(db_session, "ctl6a@rvaiglobal.com")
    intruder = await UserFactory.create(db_session, email="ctl6b@rvaiglobal.com")
    r = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(owner),
    )
    sid = r.json()["sessionId"]
    await drain(wire.manager, sid)
    s = await client.get(f"/v1/build-sessions/{sid}", headers=auth_headers(intruder))
    assert s.status_code == 404


async def test_stop_is_idempotent(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    brain = BlockingBrain()
    wire.app.dependency_overrides[run_build_dependency] = lambda: brain
    user, project = await _user_project(db_session, "ctl7@rvaiglobal.com")
    r = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    sid = r.json()["sessionId"]
    s1 = await client.post(f"/v1/build-sessions/{sid}/stop", json={}, headers=auth_headers(user))
    assert s1.status_code == 200 and s1.json()["status"] == "ended"
    s2 = await client.post(f"/v1/build-sessions/{sid}/stop", json={}, headers=auth_headers(user))
    assert s2.status_code == 200 and s2.json()["status"] == "ended"
    await drain(wire.manager, sid)


async def test_start_503s_with_the_exact_approved_copy_when_the_snapshot_is_unreachable(
    client: AsyncClient, db_session: AsyncSession, fake_redis, wire, monkeypatch
) -> None:
    # The 503 copy is pinned character-for-character (no trailing period): the portal renders
    # `error.message` as-is, so a reworded string here is a silently reworded product.
    from src.services.storage import accessor as storage_accessor
    from tests.fakes import FakeStorage

    class DeadStorage(FakeStorage):
        async def head(self, key):
            raise StorageError("blob is down", provider="fake", key=key)

    storage_accessor._backend_singleton = DeadStorage()
    monkeypatch.setattr("src.services.build_sessions.manager._asleep", _no_sleep)
    try:
        wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
        user, project = await _user_project(db_session, "ctl8@rvaiglobal.com")
        resp = await client.post(
            "/v1/build-sessions",
            json={"projectId": str(project.id), "prompt": "refine it"},
            headers=auth_headers(user),
        )
        assert resp.status_code == 503
        assert (
            resp.json()["error"]["message"]
            == "Sandbox unavailable. Please try again later or contact the admin"
        )
        assert wire.sbx.provisioned == []
        assert await lock_is_held(fake_redis, user.id) is False
    finally:
        storage_accessor._backend_singleton = None


async def test_start_is_503_not_500_when_redis_is_entirely_unreachable(
    client: AsyncClient, db_session: AsyncSession, dead_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl-redis-dead@rvaiglobal.com")
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "build me an app"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 503
    assert resp.status_code not in (409, 500)
    assert resp.json()["error"]["message"] == BUILD_COORDINATION_UNAVAILABLE_MSG
    assert wire.sbx.provisioned == []


async def test_start_is_503_not_409_when_only_the_lock_acquire_fails(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire, monkeypatch
) -> None:
    """Only `set` is cursed: `reconcile_user` reads with hgetall/get/exists and sails through,
    so the request reaches `acquire_lock` before anything fails — cursing any other command
    would fail earlier and prove a different thing."""
    # Mutation check: revert `acquire_lock` to `return None` and this goes red with a 409.
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl-redis-acq@rvaiglobal.com")

    async def only_the_acquire_is_down(*args: object, **kwargs: object) -> object:
        raise RedisError("redis is down")

    monkeypatch.setattr(fake_redis, "set", only_the_acquire_is_down)
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 503
    body = resp.json()["error"]
    assert body["message"] == BUILD_COORDINATION_UNAVAILABLE_MSG
    assert body.get("code") != "build_session_already_active"
    assert "sessionId" not in body


async def test_start_is_503_when_redis_is_not_configured(
    client: AsyncClient, db_session: AsyncSession, fake_storage, wire
) -> None:
    """Binds no `fake_redis`: that fixture binds the client singleton, and with it in place
    `RedisNotConfiguredError` is unreachable by construction and this branch untestable."""
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl-redis-off@rvaiglobal.com")
    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 503
    assert resp.json()["error"]["message"] == BUILD_COORDINATION_UNAVAILABLE_MSG
    assert wire.sbx.provisioned == []


async def test_start_reaps_through_anothers_dead_residue_at_the_acquire_seam(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    wire.app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl-contend@rvaiglobal.com")
    await seed_live_sandbox_state(fake_redis, user.id)

    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )
    assert resp.status_code == 201
    assert wire.sbx.provisioned != []
    await drain(wire.manager, resp.json()["sessionId"])


async def test_start_documents_the_503_in_its_openapi_responses(client: AsyncClient) -> None:
    schema = (await client.get("/openapi.json")).json()
    responses = schema["paths"]["/v1/build-sessions"]["post"]["responses"]
    assert "503" in responses
    assert "coordination" in responses["503"]["description"]


async def test_start_is_503_when_the_sandbox_is_not_configured(
    client: AsyncClient, db_session: AsyncSession, app
) -> None:
    """Takes no sandbox fixture, and binds the brain deliberately: with the brain unbound the
    `run_build is None` refusal answers first and masks the sandbox arm under test."""
    app.dependency_overrides[run_build_dependency] = lambda: FakeBrain()
    user, project = await _user_project(db_session, "ctl-sbx-off@rvaiglobal.com")

    resp = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "p"},
        headers=auth_headers(user),
    )

    assert resp.status_code == 503
    body = resp.json()
    assert (
        body["error"]["message"]
        == "Sandbox unavailable. Please try again later or contact the admin"
    )
    assert "detail" not in body


# --- stop-and-switch, over HTTP -------------------------------------------------------


async def _stop_active(client: AsyncClient, user, project, *, csrf: bool = True):
    return await client.post(
        f"/v1/build-sessions/projects/{project.id}/stop-active-build",
        headers=auth_headers(user, with_csrf=csrf),
    )


async def _stop_state(client: AsyncClient, user, project):
    """Deliberately WITHOUT the CSRF header. It is a GET that changes nothing, and sending one
    would hide a route that had quietly started requiring it."""
    return await client.get(
        f"/v1/build-sessions/projects/{project.id}/stop-state",
        headers=auth_headers(user, with_csrf=False),
    )


async def _stopped_state(client: AsyncClient, user, project) -> str:
    """A bounded poll of the real condition rather than a sleep: a fixed sleep here could only
    be too short, and would then report an absence it had never waited long enough to observe."""
    for _ in range(400):
        body = (await _stop_state(client, user, project)).json()
        if body["state"] != "still_running":
            return str(body["state"])
        await asyncio.sleep(0.01)
    raise AssertionError("the stop never left 'still running'")


async def test_stop_active_build_settles_a_live_build_so_release_can_proceed(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """THE BARRIER: the POST no longer waits, it asks — so the release below has to sit under
    the STATUS READ and not under the ask, or it measures a system that has not finished."""
    brain = BlockingBrain()
    wire.app.dependency_overrides[run_build_dependency] = lambda: brain
    user, project = await _user_project(db_session, "ctl-stop1@rvaiglobal.com")
    started = await client.post(
        "/v1/build-sessions",
        json={"projectId": str(project.id), "prompt": "build it"},
        headers=auth_headers(user),
    )
    assert started.status_code == 201
    sid = started.json()["sessionId"]

    save = await client.post(
        f"/v1/build-sessions/projects/{project.id}/save", headers=auth_headers(user)
    )
    assert save.status_code == 409
    assert "still being built" in save.json()["error"]["message"]
    release = await client.post(
        f"/v1/build-sessions/projects/{project.id}/release", headers=auth_headers(user)
    )
    assert release.status_code == 409

    # The gate stays SHUT: releasing the brain first would let the build finish on its own and
    # every assertion below would pass without the route having done anything.
    asked = await _stop_active(client, user, project)

    assert asked.status_code == 200
    assert asked.json()["state"] == "still_running"

    assert await _stopped_state(client, user, project) == "stopped"

    after = await client.post(
        f"/v1/build-sessions/projects/{project.id}/release", headers=auth_headers(user)
    )
    assert after.status_code != 409
    brain.release()
    await drain(wire.manager, sid)


def test_the_published_api_names_the_stop_states_the_wire_actually_sends(app: FastAPI) -> None:
    """FastAPI publishes a route's docstring as its OpenAPI description, so prose in a route is
    API surface. `CamelModel` camelizes FIELD names and nothing else — `StopOutcome` is a plain
    string enum whose values go out verbatim — so a docstring saying `nothingWasRunning` tells a
    reader to branch on a value the wire never sends.

    SPELLING-BLIND rather than a list of the known wrong spellings: any backticked token that is
    a state name with its separators or casing changed is a token no client can match, whichever
    way someone rewrites it later. The Python MEMBER names (`STILL_RUNNING`) are allowed beside
    the values, because prose naming the enum member is talking about the symbol."""
    # Mutation check: put `nothingWasRunning` back in any of the stop docstrings and this goes red.
    published = json.dumps(app.openapi())
    spellings = {outcome.value for outcome in StopOutcome} | {
        outcome.name for outcome in StopOutcome
    }
    flattened = {outcome.value.replace("_", ""): outcome.value for outcome in StopOutcome}
    named = {
        token
        for token in re.findall(r"`([A-Za-z_]+)`", published)
        if token.lower().replace("_", "") in flattened
    }
    # LIVENESS: an empty set satisfies the loop below trivially, and is also what a schema that
    # failed to render its descriptions produces.
    assert named, "no stop state is named anywhere in the published schema"
    for token in sorted(named):
        assert token in spellings, (
            f"the published API tells a client to branch on `{token}`; the wire sends "
            f"`{flattened[token.lower().replace('_', '')]}`"
        )


async def test_stopping_a_settled_project_says_nothing_was_running_not_an_error(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ctl-stop2@rvaiglobal.com")
    resp = await _stop_active(client, user, project)
    assert resp.status_code == 200
    assert resp.json()["state"] == "nothing_was_running"

    read = await _stop_state(client, user, project)
    assert read.status_code == 200
    assert read.json()["state"] == "nothing_was_running"


async def test_stop_active_build_is_owner_scoped_and_csrf_guarded(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    owner, project = await _user_project(db_session, "ctl-stop3@rvaiglobal.com")
    stranger = await UserFactory.create(db_session, email="ctl-stop4@rvaiglobal.com")

    assert (await _stop_active(client, stranger, project)).status_code == 404
    assert (await _stop_active(client, owner, project, csrf=False)).status_code == 403


async def test_the_stop_state_read_is_owner_scoped_and_needs_no_csrf(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    owner, project = await _user_project(db_session, "ctl-stop5@rvaiglobal.com")
    stranger = await UserFactory.create(db_session, email="ctl-stop6@rvaiglobal.com")

    assert (await _stop_state(client, stranger, project)).status_code == 404
    mine = await _stop_state(client, owner, project)
    assert mine.status_code == 200
    assert mine.json()["state"] == "nothing_was_running"


async def test_stop_active_build_answers_without_redis(
    client: AsyncClient, db_session: AsyncSession, fake_storage, wire
) -> None:
    """Deliberately takes no `fake_redis` fixture: with the singleton unset `get_redis()` raises
    `RedisNotConfiguredError`, which is what a deployment with no Redis configured does."""
    user, project = await _user_project(db_session, "ctl-stop-noredis@rvaiglobal.com")
    resp = await _stop_active(client, user, project)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"state": "nothing_was_running"}

    read = await _stop_state(client, user, project)
    assert read.status_code == 200, read.text
    assert read.json() == {"state": "nothing_was_running"}
