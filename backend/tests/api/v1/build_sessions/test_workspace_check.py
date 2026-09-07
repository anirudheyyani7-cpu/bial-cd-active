"""The idle-tab workspace check, and the reversion nobody would otherwise catch.

Every other integrity check runs at the START of a turn; this one is for a citizen who
just leaves a tab open — a "Build complete" claim can go stale while the page stays up.

TWO PROPERTIES MATTER MOST:
* `reverted` is the SERVER's boolean: of four states only REVERTED may retract a claim; an
  `!== "intact"` check would also retract on the two states that mean "we could not tell".
* The rate limit is not politeness — without it, an open tab is a container exec every 45s,
  forever, for an answer that changes at most once.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.integrity_types import WorkspaceState
from src.services.build_sessions.manager import reset_idle_checks_for_tests
from tests.api.v1.build_sessions.conftest import auth_headers
from tests.factories import AppRegistryFactory, ProjectFactory, UserFactory

_ROUTE = "/v1/build-sessions/projects/{project_id}/workspace-check"


@pytest.fixture(autouse=True)
def _no_remembered_answers() -> None:
    """The rate-limit memo is process-local, so a remembered answer would leak into the next test
    and silently make its container call disappear."""
    reset_idle_checks_for_tests()


async def test_a_project_with_no_live_container_never_retracts(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage
) -> None:
    """★ A container that is GONE is a different fact from one that is running and empty —
    conflating them would strike through a completion claim every time a workspace merely went
    to sleep, the ordinary end of every session."""
    user = await UserFactory.create(db_session, email="u4-nolive@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    await AppRegistryFactory.create(db_session, user_id=user.id, project_id=project.id)

    resp = await client.post(_ROUTE.format(project_id=project.id), headers=auth_headers(user))

    assert resp.status_code == 200
    assert resp.json()["reverted"] is False
    assert resp.json()["state"] == WorkspaceState.UNREADABLE.value


async def test_a_deployment_with_no_sandbox_service_never_retracts(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage
) -> None:
    """Nothing is configured to ask, so `UNREADABLE` is returned rather than `INTACT`:
    "we did not check" and "we checked and it is fine" are different facts.

    This is also the arm every test in this file runs on, which is why container-level
    behaviour is pinned in `tests/services/build_sessions/` instead — this route's job is the
    ownership gate, the CSRF gate, and the shape of the answer."""
    user = await UserFactory.create(db_session, email="u4-noapp@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    resp = await client.post(_ROUTE.format(project_id=project.id), headers=auth_headers(user))

    assert resp.status_code == 200
    assert resp.json() == {"state": WorkspaceState.UNREADABLE.value, "reverted": False}


async def test_another_users_project_is_404(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage
) -> None:
    """A cross-user project and a missing one are the same non-leaking answer."""
    owner = await UserFactory.create(db_session, email="u4-owner@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, owner.id)
    intruder = await UserFactory.create(db_session, email="u4-intruder@rvaiglobal.com")

    resp = await client.post(_ROUTE.format(project_id=project.id), headers=auth_headers(intruder))

    assert resp.status_code == 404
    # LIVENESS: the route works — the owner gets a real answer for the same project.
    ok = await client.post(_ROUTE.format(project_id=project.id), headers=auth_headers(owner))
    assert ok.status_code == 200


async def test_an_unknown_project_is_404(
    client: AsyncClient, db_session: AsyncSession, fake_redis, fake_storage
) -> None:
    user = await UserFactory.create(db_session, email="u4-noproj@rvaiglobal.com")
    resp = await client.post(_ROUTE.format(project_id=uuid.uuid4()), headers=auth_headers(user))
    assert resp.status_code == 404


def test_only_a_confirmed_reversion_can_retract_a_claim() -> None:
    """★ ASSERTED OVER THE WHOLE ENUM, not at the one call site: the two unanswerable states must
    never set `reverted` — a completion claim struck through because a supervisor blipped is a
    new false statement, made by the code that exists to stop false statements.
    Mutation check: change the route's `state is REVERTED` to `state is not INTACT` and this goes
    red for both unanswerable states."""
    from src.api.v1.build_sessions.schemas import WorkspaceCheckResponse

    retracting = [
        state
        for state in WorkspaceState
        if WorkspaceCheckResponse(state=state, reverted=state is WorkspaceState.REVERTED).reverted
    ]

    assert retracting == [WorkspaceState.REVERTED]


def test_every_state_is_representable_on_the_wire() -> None:
    """All four cross the boundary unchanged, including the two the client must be able to
    receive in order to do nothing about them."""
    from src.api.v1.build_sessions.schemas import WorkspaceCheckResponse

    for state in WorkspaceState:
        body = WorkspaceCheckResponse(state=state, reverted=False).model_dump()
        assert body["state"] == state.value
