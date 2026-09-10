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
    REGISTRY_FIELD_SERVING_SINCE,
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


#: A stamp that reads as PROVEN — an instant something watched this container's app answer a
#: request. Any non-empty ISO-8601 value does; a fixed one keeps the assertions readable.
SERVED = "2026-09-10T09:41:04+00:00"

#: The create-time sentinel `_write_registry` seeds: the container exists and has NEVER served.
NEVER_SERVED = ""


async def _register_container(
    redis, user_id: uuid.UUID, app_name: str, *, state: str, serving_since: str
) -> None:
    """Write the registry hash by hand rather than through a relaunch: this route reads the
    registry and nothing else, so a provisioning path in the setup would test the path
    instead of the read.

    `serving_since` IS REQUIRED, AND THAT KEYWORD IS THE POINT OF THIS FIXTURE. It used to write
    five fields and no stamp, and an ABSENT stamp is the PRE-CUTOVER reading, which the rollout
    grandfathers as PROVEN — so every `alive` assertion in this file passed through the
    grandfather arm and would have gone on passing with the new STARTING arm deleted or
    inverted. A fix landing while the guard meant to prove it is blind is this repo's own
    recorded failure shape. Naming the reading at every call site is what stops it: a test that
    wants ALIVE says `serving_since=SERVED` and means it, and a test that wants the pre-cutover
    arm calls `_register_a_pre_cutover_container` and says THAT out loud."""
    await redis.hset(
        registry_key(user_id),
        mapping={
            REGISTRY_FIELD_APP_NAME: app_name,
            REGISTRY_FIELD_FQDN: f"{app_name}.example.azurecontainerapps.io",
            REGISTRY_FIELD_TOKEN_REF: f"ref-{app_name}",
            REGISTRY_FIELD_CREATED_AT: datetime.now(UTC).isoformat(),
            REGISTRY_FIELD_STATE: state,
            REGISTRY_FIELD_SERVING_SINCE: serving_since,
        },
    )


async def _register_a_pre_cutover_container(
    redis, user_id: uuid.UUID, app_name: str, *, state: str
) -> None:
    """The hash as it was written BEFORE `serving_since` existed — the fleet that is live at the
    deploy instant. Field for field the same as its sibling minus the stamp, deliberately spelled
    out rather than expressed as `_register_container(..., serving_since=None)`: the sibling's
    whole job is to refuse to let a caller leave the reading unstated, and an `Optional` would
    hand that hole straight back."""
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


def _state_and_instant(body: dict[str, Any]) -> tuple[str, object]:
    """The two fields that must never disagree, as one tuple — so a failure names both."""
    return (body["state"], body["servingSince"])


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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
    )

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["alive"] is True
    assert body["previewUrl"] == (f"https://citizenapps.bialairport.com/a/{app_name_for(app_id)}")
    assert "azurecontainerapps.io" not in body["previewUrl"]
    assert body["occupyingProjectName"] is None
    # ALIVE NOW MEANS SERVED. This container carries a real stamp, so the answer comes off the
    # proven arm rather than the pre-cutover grandfather — see the serving-proof section below.
    assert body["servingSince"] is not None


async def test_another_project_holding_the_slot_is_named(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    user, mine = await _user_project(db_session, "ps-taken@rvaiglobal.com")
    theirs = await ProjectFactory.create(db_session, user.id, name="Baggage Reconciliation")
    await _built(db_session, user, mine)
    other_app = await _built(db_session, user, theirs)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(other_app),
        state=REGISTRY_STATE_READY,
        serving_since=SERVED,
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
    await _register_container(
        fake_redis, user.id, "sbx-somebodyelses", state=REGISTRY_STATE_READY, serving_since=SERVED
    )

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
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_ENDING,
        serving_since=SERVED,
    )

    body = await _probe(client, user, project)

    assert body["state"] == "asleep"
    assert body["previewUrl"] is None, "never hand back a URL for a container being destroyed"


# --------------------------------------------------------------------------------------
# The serving proof — ALIVE means SERVED, not SCHEDULED
#
# `state=ready` on the registry hash says an ACA container was CREATED. Until the stamp
# existed, the platform reported that as "your app is running", handed out a framable URL, and
# on 2026-09-10 a citizen watched nginx's "This app isn't running right now" page inside their
# own healthy build for eight seconds while the live region announced the preview was live.
#
# THE THREE READINGS OF `serving_since` ARE THE WHOLE CONTRACT and each gets its own test
# below, because the middle one is the fix, the first one is the rollout, and getting either
# wrong is a fleet-scale outage in one direction or the shipped bug in the other.
# --------------------------------------------------------------------------------------


async def test_a_container_that_has_never_answered_a_request_is_a_wait_not_a_running_app(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """★ THE FIX, and the reading in the middle: `serving_since == ""` means the container
    exists and has never served. That is the measured 48s→56s window, in which every byte of
    this hash already said `ready`.

    NO URL IS THE HALF THAT MATTERS. `starting` is in the client's frame veto, so withholding
    the address is what stops an iframe mounting on nginx's app-gone page — the state name alone
    would not.

    Mutation-check: delete the `if not _stamp_is_proven(reg)` arm from `project_preview_state`
    (or invert it to `if _stamp_is_proven(reg)`) and this goes red on `state`."""
    user, project = await _user_project(db_session, "ps-scheduled@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since=NEVER_SERVED,
    )

    body = await _probe(client, user, project)

    assert body["state"] == "starting"
    assert body["alive"] is False
    assert body["previewUrl"] is None, (
        "a URL here is an iframe mounted on an app that has never answered anything"
    )
    assert body["servingSince"] is None


async def test_a_hash_written_before_the_stamp_existed_still_reads_as_running(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """The reading at the top, and it is the entire rollout: an ABSENT `serving_since` is a
    record written before this change, and it is grandfathered as PROVEN.

    Read absence as unproven instead and every container live at the deploy instant flips to
    `starting` — which the frame veto withholds the iframe on — unframing the whole serving
    fleet at once. That is a false negative at fleet scale, strictly worse than the eight-second
    window this change closes, and it is the failure `PreviewLifeState` was written to kill.

    THE GRANDFATHER ARM IS DELETABLE ONE STAY WINDOW AFTER DEPLOY (nothing writes a hash without
    the field any more — not the create-time seed, not the legacy adoption). This test is what
    makes that deletion a one-line change against a red assertion instead of an archaeology
    exercise, so DELETE IT DELIBERATELY when the time comes rather than discovering it."""
    user, project = await _user_project(db_session, "ps-precutover@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_a_pre_cutover_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY
    )

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["previewUrl"] == f"https://citizenapps.bialairport.com/a/{app_name_for(app_id)}"
    assert body["servingSince"] is None, (
        "proven, but there is no instant to name — a pre-cutover record has no first serve to "
        "report, and inventing one would put a fabricated timestamp in front of an operator"
    )


async def test_a_stamped_container_is_running_and_names_the_instant_it_first_served(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """The reading at the bottom: a real ISO-8601 instant is PROVEN, and it reaches the wire as
    the diagnostic `servingSince` so an operator can join a screenshot to the `app_first_served`
    log line rather than taking "alive" on faith."""
    user, project = await _user_project(db_session, "ps-proven@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
    )

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["previewUrl"] == f"https://citizenapps.bialairport.com/a/{app_name_for(app_id)}"
    assert datetime.fromisoformat(body["servingSince"]) == datetime.fromisoformat(SERVED)


async def test_a_stamp_nobody_can_parse_still_keeps_the_app_running(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """A CORRUPT STAMP COSTS THE DIAGNOSTIC, NEVER THE FRAME. Whatever put an unparseable value
    in this field, it was not the empty sentinel — so the container HAS served, and the honest
    answer is `alive` with nothing to report about when.

    The other way round is the tempting one and it is wrong twice over: it would unframe a
    working app over a formatting defect, and it would do it on the strength of a field whose
    docstring says no logic may branch on it."""
    user, project = await _user_project(db_session, "ps-corrupt-stamp@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since="whenever, honestly",
    )

    body = await _probe(client, user, project)

    assert body["state"] == "alive"
    assert body["previewUrl"] is not None
    assert body["servingSince"] is None, "only the diagnostic goes quiet"


async def test_a_container_that_never_served_is_still_a_wait_once_its_marker_has_gone(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """WHY THE NEW ARM SITS ABOVE THE `starting` MARKER CHECK, which is a placement and not a
    preference. The marker carries a 300s TTL; a cold build that outruns it would otherwise fall
    through to the registry arms below and offer this citizen a Launch button — or, with the
    slot held by an app row it cannot resolve, `slot_taken` — in the middle of their own build.

    No marker is written here at all, which is exactly the state a lapsed TTL leaves behind.

    Mutation-check: move the unproven arm below `if starting is not None:` and this goes red."""
    user, project = await _user_project(db_session, "ps-marker-gone@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")  # a Launch button to offer
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since=NEVER_SERVED,
    )
    assert await fake_redis.exists(starting_key(user.id)) == 0, "the marker's TTL has lapsed"

    body = await _probe(client, user, project)

    assert body["state"] == "starting"
    assert body["restorable"] is None, "no restore is offered in the middle of a citizen's build"


async def test_the_unproven_arm_spends_nothing_on_the_object_store_either(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The budget the ALIVE arm has always kept, now held across the WHOLE pre-serve window —
    which is the interval the client polls every 3 seconds. BUILDING used to be a few seconds of
    marker; it now spans every second from container-create to first serve, so an arm placed
    below `restorable_presence` would have moved a cold build's entire wait onto a Blob HEAD per
    poll without anyone noticing.

    A recovery copy EXISTS, so the empty `heads` proves the question was SKIPPED rather than
    that it had nothing to find.

    Mutation-check: move the unproven arm below `restorable_presence` and `heads` comes back
    with the recovery key in it."""
    user, project = await _user_project(db_session, "ps-unproven-budget@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await fake_storage.put(recovery_key(app_id), b"RECOVERY-BUNDLE")
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since=NEVER_SERVED,
    )

    heads: list[str] = []
    read_head = fake_storage.head

    async def record_a_head(key: str):
        heads.append(key)
        return await read_head(key)

    monkeypatch.setattr(fake_storage, "head", record_a_head)

    body = await _probe(client, user, project)

    assert body["state"] == "starting"
    assert heads == [], "the whole pre-serve window must not touch the object store"


async def test_a_reading_only_moves_from_wait_to_running_and_never_back_the_other_way(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """THE MONOTONICITY INVARIANT, which is what licenses shipping this backend alone: `alive`
    is only ever emitted LATER than it used to be, never earlier. One container, one hash, read
    twice — the only thing that changes between the reads is the stamp landing.

    This is the assertion that catches a future editor who "optimises" the ALIVE arm by relaxing
    the stamp check, and it is also why absence is grandfathered rather than age-boxed: an age
    box can emit alive→starting for a pre-cutover container that is serving perfectly, which
    retires a working frame."""
    user, project = await _user_project(db_session, "ps-monotone@rvaiglobal.com")
    app_id = await _built(db_session, user, project)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since=NEVER_SERVED,
    )

    before = await _probe(client, user, project)

    # The one write an observer makes when it watches the app answer — nothing else changes.
    await fake_redis.hset(registry_key(user.id), REGISTRY_FIELD_SERVING_SINCE, SERVED)

    after = await _probe(client, user, project)

    assert (before["state"], after["state"]) == ("starting", "alive")
    assert before["previewUrl"] is None and after["previewUrl"] is not None


async def test_no_state_but_running_ever_names_a_serving_instant(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """`servingSince` is DIAGNOSTIC ONLY and non-null strictly when `state == alive`. Pinned
    because it is the same fact as `state` spelled a second time from one read: let it leak onto
    another arm and a client computing liveness as `servingSince !== null` — which the field's
    own docstring forbids, and which somebody will write anyway — would disagree with `state`."""
    user, mine = await _user_project(db_session, "ps-diagnostic@rvaiglobal.com")
    named: list[tuple[str, object]] = []

    named.append(_state_and_instant(await _probe(client, user, mine)))  # never_built

    app_id = await _built(db_session, user, mine)
    named.append(_state_and_instant(await _probe(client, user, mine)))  # asleep

    await write_starting_marker(fake_redis, user.id, mine.id)
    named.append(_state_and_instant(await _probe(client, user, mine)))  # starting (the marker)
    await fake_redis.delete(starting_key(user.id))

    await _register_container(
        fake_redis,
        user.id,
        app_name_for(app_id),
        state=REGISTRY_STATE_READY,
        serving_since=NEVER_SERVED,
    )
    named.append(_state_and_instant(await _probe(client, user, mine)))  # starting (unproven)

    theirs = await ProjectFactory.create(db_session, user.id, name="Gate Rostering")
    other_app = await _built(db_session, user, theirs)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(other_app),
        state=REGISTRY_STATE_READY,
        serving_since=SERVED,
    )
    named.append(_state_and_instant(await _probe(client, user, mine)))  # slot_taken

    assert named == [
        ("never_built", None),
        ("asleep", None),
        ("starting", None),
        ("starting", None),
        ("slot_taken", None),
    ]
    # …and the positive control, so the list above proves an omission rather than a field that
    # is simply never populated at all.
    await _register_container(
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
    )
    assert _state_and_instant(await _probe(client, user, mine))[1] is not None


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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
    )
    seen.append((await _probe(client, user, mine))["state"])

    theirs = await ProjectFactory.create(db_session, user.id, name="Stand Allocation")
    other_app = await _built(db_session, user, theirs)
    await _register_container(
        fake_redis,
        user.id,
        app_name_for(other_app),
        state=REGISTRY_STATE_READY,
        serving_since=SERVED,
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
        fake_redis, user.id, app_name_for(app_id), state=REGISTRY_STATE_READY, serving_since=SERVED
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


async def test_a_launch_that_proves_the_app_serves_stamps_it_and_the_pane_says_running(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
) -> None:
    """THE RELAUNCH OBSERVER, end to end and through the real route. `wait_ready` returning
    without `SandboxNotReadyError` IS the proof — it means a request to the app root actually
    succeeded — so the very poll that follows the press already answers `alive`, with no second
    round trip and no watcher needing to catch up.

    Driven from the container's create-time sentinel rather than a hand-written stamp: the
    registry hash here is written by the provisioning path, so this asserts the whole chain
    (`_write_registry` seeds `""` → the relaunch stamps it → the poll reads it), which is the
    one thing three separate unit tests cannot say between them."""
    user, project = await _user_project(db_session, "ps-launch-proves@rvaiglobal.com")
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    launched = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )

    assert launched.status_code == 200
    assert launched.json()["ready"] is True
    stamped = await fake_redis.hget(registry_key(user.id), REGISTRY_FIELD_SERVING_SINCE)
    assert stamped, "the relaunch watched the app answer and recorded nothing"
    assert (await _probe(client, user, project))["state"] == "alive"


async def test_a_readiness_timeout_on_the_attach_arm_takes_the_serving_proof_back(
    client: AsyncClient,
    db_session: AsyncSession,
    fake_redis,
    fake_storage,
    wire,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """★ THE ONE PLACE OUTSIDE A LIVE TURN THAT CAN RETRACT. This arm has just watched a root
    GET fail against a container it attached to — real evidence the app is not answering — and
    that container HAS served, so it carries an instant nothing else would ever clear: the only
    other clearer, the turn watcher's crash edge, exists only while a turn is streaming.

    Without this the pane goes on reporting RUNNING and frames nginx's "This app isn't running
    right now" page: the measured 2026-09-10 defect, one door down.

    IT MARKS NOTHING `ending` AND TEARS NOTHING DOWN, and that is not timidity — condemning a
    container for a slow root GET once cost a citizen their unsaved work. Retracting a claim
    costs them a card. The sibling test above pins the non-destruction in full; what is added
    here is that the claim itself comes off, and that the pane follows."""
    user, project = await _user_project(db_session, "ps-timeout-retracts@rvaiglobal.com")
    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.commit()
    await fake_storage.put(snapshot_key(app_id), b"SAVED-BUNDLE")

    cold = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )
    assert cold.status_code == 200
    assert await fake_redis.hget(registry_key(user.id), REGISTRY_FIELD_SERVING_SINCE), (
        "guard the premise: there has to be a standing proof for the retraction to take back"
    )
    assert (await _probe(client, user, project))["state"] == "alive"

    wire.sbx.attach_handle = SandboxHandle(
        fqdn="live.example",
        token="tok",  # noqa: S106 - a fake, never a real bearer
        app_name=app_name_for(app_id),
        preview_url="https://live.example",
        ready=True,
    )
    torn_down_before = list(wire.sbx.torn_down)

    async def the_dev_server_stopped_answering(handle: SandboxHandle, *, timeout_s: float = 120.0):
        raise SandboxNotReadyError("the app root never served")

    monkeypatch.setattr(wire.sbx, "wait_ready", the_dev_server_stopped_answering)

    degraded = await client.post(
        "/v1/build-sessions/relaunch",
        json={"projectId": str(project.id)},
        headers=auth_headers(user),
    )

    assert degraded.status_code == 200
    assert degraded.json()["ready"] is False
    # BACK TO THE SENTINEL, NEVER DELETED: an absent field is the pre-cutover reading and is
    # grandfathered as PROVEN, so a delete here would report the dead app as running again.
    assert await fake_redis.hexists(registry_key(user.id), REGISTRY_FIELD_SERVING_SINCE) == 1
    assert await fake_redis.hget(registry_key(user.id), REGISTRY_FIELD_SERVING_SINCE) == ""
    assert wire.sbx.torn_down == torn_down_before, "a claim was retracted by destroying something"

    settled = await _probe(client, user, project)
    assert settled["state"] == "starting", "the pane went on framing an app that stopped serving"
    assert settled["previewUrl"] is None


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


# --- a workspace somebody else is holding, BEFORE this project has ever built -------------------
#
# ★ THE VANISHING MESSAGE. `project_preview_state`'s "no app row -> NEVER_BUILT" arm used to sit
# ABOVE the slot-taken check, which made SLOT_TAKEN structurally unreachable for a project that had
# never built — the project most likely to meet it, since a citizen only ever has one workspace.
#
# WHAT IT COST, MEASURED ON 2026-09-10 IN TWO OF THREE REAL RUNS: the pane said "Describe what you
# want to build." over a workspace another project was holding. The citizen typed, pressed send,
# the server refused the start with a 409, and the composer — which rolls both bubbles back on a
# refusal, correctly — left NOTHING on screen. No message, no error, no card, no button. The
# platform's answer to "why did my message disappear" was a sentence inviting them to type it again.


async def test_a_first_time_project_reports_a_workspace_another_project_is_holding(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """★ The arm that could not be reached. No app row here, and the registry names somebody
    else's container: the honest answer is SLOT_TAKEN, not "you have never built anything".

    Mutation-check: move the `NEVER_BUILT` return back above the registry read in
    `project_preview_state` and this goes red on `state`.
    """
    user, project = await _user_project(db_session, "ps-held-first@rvaiglobal.com")
    await _register_container(
        fake_redis, user.id, "sbx-somebodyelses", state=REGISTRY_STATE_READY, serving_since=""
    )

    body = await _probe(client, user, project)

    assert body["state"] == "slot_taken", "a held workspace read as 'never built'"
    # STILL A CONFIRMED ABSENT. No app row means no bundle key can exist, so this is an answer
    # rather than an omission — and the card must not offer to restore something that cannot exist.
    assert body["restorable"] is False
    assert body["previewUrl"] is None


async def test_a_first_time_project_with_a_free_workspace_still_says_never_built(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage, wire
) -> None:
    """THE OTHER HALF, and the reason the fix is a reorder rather than a replacement: with nothing
    holding the workspace, "nothing has been built here" is still the true and useful answer.

    Mutation-check: make the new arm answer SLOT_TAKEN unconditionally and this goes red — which
    is what stops the fix from turning every empty project into a held one."""
    user, project = await _user_project(db_session, "ps-free-first@rvaiglobal.com")

    body = await _probe(client, user, project)

    assert body["state"] == "never_built"
    assert body["restorable"] is False
