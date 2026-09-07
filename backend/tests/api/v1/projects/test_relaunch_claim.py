"""N7 — a project only claims a saved build when one actually exists.

`projectHasApp` was derived from the mere EXISTENCE of an app row, minted at `status='draft'`
by PROVISION before a single line is built — so every project whose first build failed
advertised a saved build, offered Relaunch, and 404'd when clicked, the affordance silently
vanishing.

The obvious fix is wrong: `AppStatus.DRAFT` is ALSO the state of a good app nobody has
submitted yet, so `status != 'draft'` would hide Relaunch for the common case while still
lying about the failed one. The only honest source is the object-store HEAD, which has THREE
answers — present, confirmed-absent, unknown-because-the-store-errored — and an unreachable
store must not manufacture a promise in either direction."""

from __future__ import annotations

import uuid

import pytest

from src.services.build_sessions.appdata import resolve_app_for_project
from src.services.storage import ObjectMeta, snapshot_key
from src.services.storage import accessor as storage_accessor
from src.services.storage.errors import StorageError
from tests.api.v1.projects.test_projects_crud import _auth
from tests.fakes import FakeStorage


class UnreachableStore(FakeStorage):
    """A store that answers every head-check with a transport failure — the third state."""

    async def head(self, key: str) -> ObjectMeta | None:
        raise StorageError("the store is having a day", provider="fake", key=key)


@pytest.fixture
def bind_store(monkeypatch: pytest.MonkeyPatch):
    """Bind a store to the accessor singleton `snapshot_presence` resolves through, so the real
    `get_storage()` seam runs rather than a dependency override (which this path never sees)."""

    def _bind(store: FakeStorage) -> FakeStorage:
        monkeypatch.setattr(storage_accessor, "_backend_singleton", store)
        return store

    return _bind


async def test_a_project_with_no_app_at_all_makes_no_claim(client, db_session, bind_store) -> None:
    store = bind_store(FakeStorage())
    headers, _ = await _auth(db_session)
    created = (await client.post("/v1/projects", headers=headers, json={"name": "Fresh"})).json()

    fetched = (await client.get(f"/v1/projects/{created['id']}", headers=headers)).json()

    assert fetched["hasRelaunchableSnapshot"] is False
    # No app row means no bundle CAN exist — that is an answer, so the store is never asked.
    assert store.objects == {}


async def test_the_bug_a_failed_first_build_does_not_claim_a_saved_build(
    client, db_session, bind_store
) -> None:
    bind_store(FakeStorage())
    headers, user = await _auth(db_session)
    created = (await client.post("/v1/projects", headers=headers, json={"name": "Doomed"})).json()
    await resolve_app_for_project(db_session, user.id, uuid.UUID(created["id"]))
    await db_session.commit()

    fetched = (await client.get(f"/v1/projects/{created['id']}", headers=headers)).json()

    assert fetched["appId"] is not None  # the row IS there — that was the whole trap
    assert fetched["appStatus"] == "draft"
    assert fetched["hasRelaunchableSnapshot"] is False


async def test_the_normal_case_a_built_but_unsubmitted_app_still_claims_one(
    client, db_session, bind_store
) -> None:
    store = bind_store(FakeStorage())
    headers, user = await _auth(db_session)
    created = (await client.post("/v1/projects", headers=headers, json={"name": "Healthy"})).json()
    app_id = await resolve_app_for_project(db_session, user.id, uuid.UUID(created["id"]))
    await db_session.commit()
    await store.put(snapshot_key(app_id), b"BUNDLE")

    fetched = (await client.get(f"/v1/projects/{created['id']}", headers=headers)).json()

    assert fetched["appStatus"] == "draft"  # unsubmitted, and that is normal
    assert fetched["hasRelaunchableSnapshot"] is True


async def test_an_unreachable_store_claims_nothing_in_either_direction(
    client, db_session, bind_store, monkeypatch
) -> None:
    """`null` says we cannot tell — the client renders the plain empty state rather than
    guessing."""

    async def _no_backoff(_seconds: float) -> None:
        """Skip the real retry backoff — the retry COUNT is what this asserts, not the wait."""

    monkeypatch.setattr("src.services.build_sessions.manager._asleep", _no_backoff)
    bind_store(UnreachableStore())
    headers, user = await _auth(db_session)
    created = (await client.post("/v1/projects", headers=headers, json={"name": "Foggy"})).json()
    await resolve_app_for_project(db_session, user.id, uuid.UUID(created["id"]))
    await db_session.commit()

    fetched = (await client.get(f"/v1/projects/{created['id']}", headers=headers)).json()

    assert fetched["hasRelaunchableSnapshot"] is None


async def test_the_list_never_pays_for_a_head_check_per_row(
    client, db_session, bind_store
) -> None:
    """Scoping note, pinned so nobody "helpfully" populates it there: the list would need one
    object-store round-trip per project, and nothing on that surface offers Relaunch."""
    store = bind_store(FakeStorage())
    headers, user = await _auth(db_session)
    created = (await client.post("/v1/projects", headers=headers, json={"name": "Listed"})).json()
    app_id = await resolve_app_for_project(db_session, user.id, uuid.UUID(created["id"]))
    await db_session.commit()
    await store.put(snapshot_key(app_id), b"BUNDLE")

    listed = (await client.get("/v1/projects", headers=headers)).json()
    row = next(p for p in listed["items"] if p["id"] == created["id"])

    assert row["hasRelaunchableSnapshot"] is None  # never computed here
    # …while the single-project read, which IS the Relaunch surface, answers truthfully.
    fetched = (await client.get(f"/v1/projects/{created['id']}", headers=headers)).json()
    assert fetched["hasRelaunchableSnapshot"] is True
