"""`GET /v1/build-sessions/projects/{id}/preview-state` — five states, not one boolean."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from redis.exceptions import ConnectionError as RedisConnectionError
from sqlalchemy.ext.asyncio import AsyncSession

from src.api.v1.build_sessions.schemas import (
    PREVIEW_STATE_ACTION,
    PreviewLifeState,
    PreviewStateAction,
)
from src.services.build_sessions.appdata import resolve_app_for_project
from src.services.build_sessions.locks import write_starting_marker
from src.services.build_sessions.manager import app_name_for
from src.services.redis import (
    REGISTRY_STATE_ENDING,
    REGISTRY_STATE_READY,
    registry_key,
)
from src.services.redis.keys import (
    REGISTRY_FIELD_APP_NAME,
    REGISTRY_FIELD_CREATED_AT,
    REGISTRY_FIELD_FQDN,
    REGISTRY_FIELD_STATE,
    REGISTRY_FIELD_TOKEN_REF,
    starting_key,
)
from src.services.sandbox import SandboxHandle, SandboxNotReadyError
from src.services.storage import StorageError, recovery_key, snapshot_key
from tests.api.v1.build_sessions.conftest import auth_headers
from tests.factories import ProjectFactory, UserFactory


async def _user_project(db: AsyncSession, email: str):
    user = await UserFactory.create(db, email=email)
    project = await ProjectFactory.create(db, user.id)
    return user, project


async def _built(db: AsyncSession, user, project) -> uuid.UUID:
    """Give the project an app row without staging any bundle."""
    app_id = await resolve_app_for_project(db, user.id, project.id)
    await db.commit()
    return app_id


async def _register_container(redis, user_id: uuid.UUID, app_name: str, *, state: str) -> None:
    """Write the registry hash by hand rather than through a relaunch: this route reads the
    registry and nothing else, so a provisioning path in the setup would test the path
    instead of the read."""
    await redis.hset(
        registry_key(user_id),
        mapping={
            REGISTRY_FIELD_APP_NAME: app_name,
            REGISTRY_FIELD_FQDN: f"{app_name}.example.azurecontainerapps.io",
            REGISTRY_FIELD_TOKEN_REF: f"ref-{app_name}",
            REGISTRY_FIELD_CREATED_AT: datetime.now(UTC).isoformat(),
            REGISTRY_FIELD_STATE: state,
        },
    )


async def _probe(client: AsyncClient, user, project) -> dict[str, Any]:
    resp = await client.get(
        f"/v1/build-sessions/projects/{project.id}/preview-state", headers=auth_headers(user)
    )
    assert resp.status_code == 200, resp.text
    body: dict[str, Any] = resp.json()
    assert body["alive"] is (body["state"] == "alive")
    return body


@pytest.fixture
def instant_backoff(monkeypatch: pytest.MonkeyPatch) -> None:
    """Collapse the waiting in `head_presence`'s retry backoff, never the ladder itself: the
    ladder is what makes an unreachable store answer `null` instead of `false`."""
    from src.services.build_sessions import manager as manager_module

    async def no_waiting(_seconds: float) -> None:
        return None

    monkeypatch.setattr(manager_module, "_asleep", no_waiting)


# --------------------------------------------------------------------------------------
# The states
# --------------------------------------------------------------------------------------


async def test_a_project_nobody_ever_built_says_so(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-new@rvaiglobal.com")

    body = await _probe(client, user, project)

    assert body["state"] == "never_built"
    assert body["restorable"] is False
    assert body["previewUrl"] is None


async def test_a_reclaimed_workspace_is_asleep_and_offers_the_work_back(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    # Mutation-check: point `restorable_presence` at `snapshot_key` alone (its shipped predecessor)
    # and `restorable` comes back False, which is the sentence this test exists to stop the product
    # saying.
    user, project = await _user_project(db_session, "ps-asleep@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(recovery_key(app_id), b"RECOVERY-BUNDLE")
    assert snapshot_key(app_id) not in fake_storage.objects, "the user never pressed Save"

    body = await _probe(client, user, project)

    assert body["state"] == "asleep"
    assert body["restorable"] is True
    assert body["alive"] is False


async def test_a_saved_build_with_no_recovery_copy_is_also_restorable(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-saved@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    body = await _probe(client, user, project)

    assert (body["state"], body["restorable"]) == ("asleep", True)


async def test_a_built_project_with_nothing_stored_is_confirmed_unrestorable(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-empty@rvaiglobal.com")
    await _built(db_session, user, project)

    body = await _probe(client, user, project)

    assert (body["state"], body["restorable"]) == ("asleep", False)


async def test_a_live_container_for_this_project_is_alive_with_a_framable_url(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-alive@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["alive"] is True
    assert body["previewUrl"] == (f"https://citizenapps.bialairport.com/a/{app_name_for(app_id)}")
    assert "azurecontainerapps.io" not in body["previewUrl"]
    assert body["occupyingProjectName"] is None


async def test_another_project_holding_the_slot_is_named(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, mine = await _user_project(db_session, "ps-taken@rvaiglobal.com")
    theirs = await ProjectFactory.create(db_session, user.id, name="Baggage Reconciliation")
    await _built(db_session, user, mine)
    other_app = await _built(db_session, user, theirs)
    await _register_container(
        fake_redis, user.id, app_name_for(other_app), state=REGISTRY_STATE_READY
    )

    body = await _probe(client, user, mine)

    assert body["state"] == "slot_taken"
    assert body["occupyingProjectName"] == "Baggage Reconciliation"
    assert body["occupyingProjectId"] == str(theirs.id)
    assert body["previewUrl"] is None, "the other project's URL is not this project's preview"


async def test_an_unattributable_container_takes_the_slot_without_naming_anyone(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-ghost@rvaiglobal.com")
    await _built(db_session, user, project)
    await _register_container(fake_redis, user.id, "sbx-somebodyelses", state=REGISTRY_STATE_READY)

    body = await _probe(client, user, project)

    assert body["state"] == "slot_taken"
    assert body["occupyingProjectName"] is None
    assert body["occupyingProjectId"] is None


async def test_a_container_of_ours_mid_teardown_reads_as_asleep_not_taken(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-ending@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_ENDING
    )

    body = await _probe(client, user, project)

    assert body["state"] == "asleep"
    assert body["previewUrl"] is None, "never hand back a URL for a container being destroyed"


# --------------------------------------------------------------------------------------
# The unknowns
# --------------------------------------------------------------------------------------


async def test_a_registry_read_failure_is_unknown_not_gone(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mutation-check: fold the `except RedisError` arm back into the `asleep` return and this goes
    # red on the `state` assertion.
    user, project = await _user_project(db_session, "ps-blip@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    from src.services.build_sessions import manager as manager_module

    async def the_store_will_not_answer(*_args: object, **_kwargs: object) -> None:
        raise RedisConnectionError("connection refused (pipeline)")

    # The route reads through `read_registry_and_starting_marker`, not a bare `read_registry`:
    # patching the latter would leave the route perfectly able to answer.
    monkeypatch.setattr(
        manager_module, "read_registry_and_starting_marker", the_store_will_not_answer
    )

    body = await _probe(client, user, project)

    assert body["state"] == "unknown"
    assert body["state"] not in {"asleep", "never_built", "slot_taken"}
    assert body["alive"] is False
    assert body["restorable"] is True


async def test_restorable_is_null_when_the_object_store_is_unreachable(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    instant_backoff: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mutation-check: make `restorable_presence` return `False` on an unreadable store and this
    # goes red — which is precisely the coercion the tri-state exists to prevent.
    user, project = await _user_project(db_session, "ps-storeblip@rvaiglobal.com")
    await _built(db_session, user, project)

    async def the_store_will_not_answer(_key: str) -> None:
        raise StorageError("azure said no", provider="fake")

    monkeypatch.setattr(fake_storage, "head", the_store_will_not_answer)

    body = await _probe(client, user, project)

    assert body["restorable"] is None
    assert body["state"] == "asleep"


async def test_one_readable_key_is_enough_to_answer_even_when_the_other_is_not(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    instant_backoff: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    user, project = await _user_project(db_session, "ps-halfblind@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(recovery_key(app_id), b"RECOVERY-BUNDLE")

    readable = fake_storage.head

    async def only_the_saved_key_is_unreadable(key: str):
        if key == snapshot_key(app_id):
            raise StorageError("azure said no", provider="fake")
        return await readable(key)

    monkeypatch.setattr(fake_storage, "head", only_the_saved_key_is_unreadable)

    body = await _probe(client, user, project)

    assert body["restorable"] is True


# --------------------------------------------------------------------------------------
# `starting`
# --------------------------------------------------------------------------------------


async def test_a_start_in_flight_reads_as_starting_from_a_different_request_and_after_reload(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-starting@rvaiglobal.com")
    await write_starting_marker(fake_redis, user.id, project.id)

    first = await _probe(client, user, project)  # a different session's request
    second = await _probe(client, user, project)  # the simulated reload, moments later

    assert first["state"] == "starting"
    assert second["state"] == "starting"
    assert first["previewUrl"] is None
    assert first["restorable"] is None


async def test_a_completed_start_clears_the_marker_and_the_next_read_answers_alive(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-start-done@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await write_starting_marker(fake_redis, user.id, project.id)

    assert (await _probe(client, user, project))["state"] == "starting"

    await fake_redis.delete(starting_key(user.id))
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    body = await _probe(client, user, project)
    assert body["state"] == "alive"


async def test_a_failed_start_clears_the_marker_through_compensation_and_reads_asleep(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Driven through the REAL start path rather than by hand-clearing the marker: the
    compensation that clears it is the thing under test."""
    from src.services.sandbox import SandboxError

    user, project = await _user_project(db_session, "ps-start-failed@rvaiglobal.com")

    async def provisioning_blows_up(*_args: object, **_kwargs: object) -> SandboxHandle:
        raise SandboxError("the container never came up")

    monkeypatch.setattr(wire.sbx, "provision_new", provisioning_blows_up)

    with pytest.raises(SandboxError):
        await wire.manager.ensure_sandbox(
            db_session, user, project.id, sandbox_client=wire.sbx, may_write=True
        )

    assert await fake_redis.exists(starting_key(user.id)) == 0

    body = await _probe(client, user, project)
    assert body["state"] == "asleep"


async def test_an_abandoned_marker_expires_and_the_next_read_falls_back_to_the_registry(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-abandoned@rvaiglobal.com")
    await _built(db_session, user, project)
    await write_starting_marker(fake_redis, user.id, project.id)
    assert (await _probe(client, user, project))["state"] == "starting"

    # The TTL lapsing: fakeredis has no fast-forward clock, so the key is deleted outright —
    # from a reader's side that is indistinguishable from the TTL having done it.
    await fake_redis.delete(starting_key(user.id))

    body = await _probe(client, user, project)
    assert body["state"] == "asleep"


async def test_a_marker_naming_another_project_is_slot_taken_and_names_it(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, mine = await _user_project(db_session, "ps-marker-taken@rvaiglobal.com")
    theirs = await ProjectFactory.create(db_session, user.id, name="Runway Allocation")
    await write_starting_marker(fake_redis, user.id, theirs.id)

    body = await _probe(client, user, mine)

    assert body["state"] == "slot_taken"
    assert body["occupyingProjectId"] == str(theirs.id)
    assert body["occupyingProjectName"] == "Runway Allocation"


async def test_a_marker_naming_this_project_while_the_registry_already_serves_it_is_alive(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, project = await _user_project(db_session, "ps-stale-marker@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )
    await write_starting_marker(fake_redis, user.id, project.id)

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["alive"] is True


# --------------------------------------------------------------------------------------
# The cost budget
# --------------------------------------------------------------------------------------


async def test_a_poll_runs_no_command_in_the_container_and_never_attaches(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mutation-check: have `project_preview_state` call `_attach_for_read` and this goes red on
    # `attaches`.
    user, project = await _user_project(db_session, "ps-cheap@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(recovery_key(app_id), b"RECOVERY-BUNDLE")
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    commands: list[list[str]] = []
    attaches: list[str] = []
    ran, attached = wire.sbx.exec, wire.sbx.attach_existing

    async def record_a_command(handle, cmd, **kwargs):
        commands.append(cmd)
        return await ran(handle, cmd, **kwargs)

    async def record_an_attach(user_id: str):
        attaches.append(user_id)
        return await attached(user_id)

    monkeypatch.setattr(wire.sbx, "exec", record_a_command)
    monkeypatch.setattr(wire.sbx, "attach_existing", record_an_attach)

    body = await _probe(client, user, project)
    assert body["state"] == "alive"

    assert commands == [], "a browser-timer poll must never run a command in the container"
    assert attaches == [], "…nor attach to it (R14: that is a manufactured activity signal)"
    assert (wire.sbx.provisioned, wire.sbx.restored, wire.sbx.torn_down) == ([], [], [])
    assert wire.sbx.warmed == []


async def test_the_alive_path_spends_nothing_on_the_object_store(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mutation-check: hoist `restorable_presence` back above the registry read (its shipped
    # position) and `heads` comes back with the recovery key in it — this goes red immediately.
    user, project = await _user_project(db_session, "ps-hotpath@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    # A recovery copy EXISTS, so the empty `heads` below proves the question was skipped rather
    # than that it had no answer to find.
    await fake_storage.put(recovery_key(app_id), b"RECOVERY-BUNDLE")
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    heads: list[str] = []
    read_head = fake_storage.head

    async def record_a_head(key: str):
        heads.append(key)
        return await read_head(key)

    monkeypatch.setattr(fake_storage, "head", record_a_head)

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert heads == [], "an alive poll must not touch the object store at all"
    assert body["restorable"] is None, "no claim — not a `false`, which would deny a real bundle"

    await fake_redis.delete(registry_key(user.id))
    body = await _probe(client, user, project)

    assert (body["state"], body["restorable"]) == ("asleep", True)
    assert heads == [recovery_key(app_id)], "one HEAD, and only where the answer is rendered"


async def test_every_state_is_reachable_and_they_are_all_different(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, mine = await _user_project(db_session, "ps-ladder@rvaiglobal.com")

    seen = [(await _probe(client, user, mine))["state"]]

    app_id = await _built(db_session, user, mine)
    seen.append((await _probe(client, user, mine))["state"])

    await write_starting_marker(fake_redis, user.id, mine.id)
    seen.append((await _probe(client, user, mine))["state"])
    await fake_redis.delete(starting_key(user.id))

    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )
    seen.append((await _probe(client, user, mine))["state"])

    theirs = await ProjectFactory.create(db_session, user.id, name="Stand Allocation")
    other_app = await _built(db_session, user, theirs)
    await _register_container(
        fake_redis, user.id, app_name_for(other_app), state=REGISTRY_STATE_READY
    )
    seen.append((await _probe(client, user, mine))["state"])

    assert seen == ["never_built", "asleep", "starting", "alive", "slot_taken"]
    assert len(set(seen)) == 5, "five states, not one boolean"


# --------------------------------------------------------------------------------------
# One round trip, two pipelined commands
# --------------------------------------------------------------------------------------


async def test_the_registry_and_marker_are_read_in_one_pipelined_round_trip(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Mutation-check: replace `read_registry_and_starting_marker`'s pipeline with two sequential
    # `redis.hgetall` / `redis.get` calls and `pipelines` goes to `[]` while `bare_reads` goes to
    # `2` — this test catches exactly that regression.
    user, project = await _user_project(db_session, "ps-pipeline@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    pipelines: list[object] = []
    bare_reads: list[str] = []
    real_pipeline = fake_redis.pipeline
    real_hgetall = fake_redis.hgetall
    real_get = fake_redis.get

    def recording_pipeline(*args: object, **kwargs: object):
        pipe = real_pipeline(*args, **kwargs)
        pipelines.append(pipe)
        return pipe

    async def recording_hgetall(*args: object, **kwargs: object):
        bare_reads.append("hgetall")
        return await real_hgetall(*args, **kwargs)

    async def recording_get(*args: object, **kwargs: object):
        bare_reads.append("get")
        return await real_get(*args, **kwargs)

    monkeypatch.setattr(fake_redis, "pipeline", recording_pipeline)
    monkeypatch.setattr(fake_redis, "hgetall", recording_hgetall)
    monkeypatch.setattr(fake_redis, "get", recording_get)

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert len(pipelines) == 1, "one round trip, not two sequential ones"
    assert bare_reads == [], "the registry and marker travel inside the pipeline, not beside it"


# --------------------------------------------------------------------------------------
# The signal→action mapping
# --------------------------------------------------------------------------------------


def test_every_preview_life_state_maps_to_exactly_one_action() -> None:
    assert set(PREVIEW_STATE_ACTION) == set(PreviewLifeState)
    for state in PreviewLifeState:
        assert PREVIEW_STATE_ACTION[state] in set(PreviewStateAction)


def test_no_ambiguous_state_maps_to_the_remedy_action() -> None:
    assert PREVIEW_STATE_ACTION[PreviewLifeState.UNKNOWN] is not PreviewStateAction.REMEDY
    assert PREVIEW_STATE_ACTION[PreviewLifeState.UNKNOWN] == PreviewStateAction.RETRY
    assert PREVIEW_STATE_ACTION[PreviewLifeState.STARTING] == PreviewStateAction.NEITHER


async def test_a_readiness_timeout_on_the_attach_arm_is_non_destructive_and_the_triple_holds(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The fake's `etag` is always `None`, so the snapshot's write time stands in for it: a
    `put` bumps the mtime on every write, so an unchanged mtime IS the unchanged-etag claim."""
    user, project = await _user_project(db_session, "ps-timeout-confirm@rvaiglobal.com")
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    # A cold relaunch first, so a real container is up and registered for this app. The attach
    # handle is set BEFORE either baseline is read: set it after, and "before" and "after"
    # would differ in what the fake can answer rather than in the timeout under test.
    cold = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )
    assert cold.status_code == 200
    wire.sbx.attach_handle = SandboxHandle(
        fqdn="live.example",
        token="tok",
        app_name=app_name_for(app_id),
        preview_url="https://live.example",
        ready=True,
    )

    save_state_url = f"/v1/build-sessions/projects/{project.id}/save-state"
    before_save_state = (await client.get(save_state_url, headers=auth_headers(user))).json()
    provisioned_before = list(wire.sbx.provisioned)
    restored_before = list(wire.sbx.restored)
    torn_down_before = list(wire.sbx.torn_down)
    snapshot_before = fake_storage.objects[snapshot_key(app_id)]
    mtime_before = fake_storage.mtimes[snapshot_key(app_id)]

    async def the_dev_server_never_answers(handle: SandboxHandle, *, timeout_s: float = 120.0):
        raise SandboxNotReadyError("the app root never served")

    monkeypatch.setattr(wire.sbx, "wait_ready", the_dev_server_never_answers)

    timed_out = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )

    assert timed_out.status_code == 200
    assert timed_out.json()["ready"] is False
    reg = await fake_redis.hgetall(registry_key(user.id))
    assert reg.get(REGISTRY_FIELD_STATE) != REGISTRY_STATE_ENDING

    assert wire.sbx.provisioned == provisioned_before
    assert wire.sbx.restored == restored_before
    assert wire.sbx.torn_down == torn_down_before
    after_save_state = (await client.get(save_state_url, headers=auth_headers(user))).json()
    assert after_save_state == before_save_state
    assert fake_storage.objects[snapshot_key(app_id)] == snapshot_before
    assert fake_storage.mtimes[snapshot_key(app_id)] == mtime_before


async def test_an_attach_that_cannot_confirm_anything_refuses_rather_than_restoring(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The status code alone cannot carry this: the restore arm answers a perfectly good 200
    with a working preview URL, having thrown away whatever was in the container it replaced.
    What is asserted instead is that nothing was torn down, provisioned or restored."""
    user, project = await _user_project(db_session, "ps-unknown-attach@rvaiglobal.com")
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    # A cold relaunch first, so a real container is up and registered for this app: without it
    # the attach below would be the certain-absent case rather than the unknown one.
    cold = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )
    assert cold.status_code == 200
    wire.sbx.attach_handle = SandboxHandle(
        fqdn="live.example",
        token="tok",
        app_name=app_name_for(app_id),
        preview_url="https://live.example",
        ready=True,
    )

    save_state_url = f"/v1/build-sessions/projects/{project.id}/save-state"
    before_save_state = (await client.get(save_state_url, headers=auth_headers(user))).json()
    provisioned_before = list(wire.sbx.provisioned)
    restored_before = list(wire.sbx.restored)
    torn_down_before = list(wire.sbx.torn_down)
    snapshot_before = fake_storage.objects[snapshot_key(app_id)]
    mtime_before = fake_storage.mtimes[snapshot_key(app_id)]

    # `SandboxNotReadyError` is a `SandboxError` and NOT a `SandboxGoneError`: raise the latter
    # here and `_attach_for_read` reports certain absence, which is the other arm entirely.
    async def the_attach_cannot_confirm_anything(user_id: str) -> SandboxHandle:
        raise SandboxNotReadyError("the supervisor did not answer")

    monkeypatch.setattr(wire.sbx, "attach_existing", the_attach_cannot_confirm_anything)

    refused = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )

    assert refused.status_code == 503

    assert wire.sbx.torn_down == torn_down_before, "the live container was destroyed"
    assert wire.sbx.provisioned == provisioned_before, "a replacement container was created"
    assert wire.sbx.restored == restored_before, "the saved bundle was pulled over live work"
    # The patch comes off BEFORE the second save-state read, and it has to: `save-state` attaches
    # too, so leaving the always-raising double in place would measure the double rather than
    # the container and report a difference that has nothing to do with the relaunch.
    monkeypatch.undo()
    after_save_state = (await client.get(save_state_url, headers=auth_headers(user))).json()
    assert after_save_state == before_save_state
    assert fake_storage.objects[snapshot_key(app_id)] == snapshot_before
    assert fake_storage.mtimes[snapshot_key(app_id)] == mtime_before

    reg = await fake_redis.hgetall(registry_key(user.id))
    assert reg.get(REGISTRY_FIELD_STATE) != REGISTRY_STATE_ENDING


async def test_a_confirmed_absent_container_still_restores(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
) -> None:
    user, project = await _user_project(db_session, "ps-cold-start-still-works@rvaiglobal.com")
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    # `attach_handle` is deliberately left `None`: that is what makes the fake raise
    # `SandboxGoneError`, its certain-absence refusal.
    assert wire.sbx.attach_handle is None

    restored = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )

    assert restored.status_code == 200
    assert restored.json()["previewUrl"]
    assert wire.sbx.restored, "the cold path must still restore, or the app never comes back"
