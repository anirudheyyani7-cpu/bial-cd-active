"""App-row resolution + the base provision-env builder (`:5432` test DB)."""

from __future__ import annotations

import uuid

import pytest
from pydantic import SecretStr
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.config import settings
from src.core.errors import AppApiError
from src.db.models.app_registry import AppRegistry, AppStatus
from src.services.build_sessions.appdata import (
    APP_SWITCHED_OFF_CODE,
    build_app_env,
    resolve_app_for_project,
)
from src.services.sandbox import SandboxNotConfiguredError
from src.services.sandbox.config import SandboxConfig
from tests.factories import AppRegistryFactory, ProjectFactory, UserFactory


def _sandbox_config() -> SandboxConfig:
    return SandboxConfig(
        subscription_id="s",
        resource_group="r",
        region="westeurope",
        managed_environment_name="aca-env",
        acr_server="bialgenaicr01.azurecr.io",
        acr_username="acr-user",
        acr_password=SecretStr("acr-pass"),
        image_ref="bialgenaicr01.azurecr.io/citizen-dev-sandbox:latest",
    )


async def test_first_build_mints_row_and_builds_env(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "sandbox", _sandbox_config())
    user = await UserFactory.create(db_session, email="c1@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    app_id = await resolve_app_for_project(db_session, user.id, project.id)
    app = await db_session.get(AppRegistry, app_id)
    assert app is not None
    assert app.user_id == user.id and app.project_id == project.id  # owner + project scoped
    # The upsert still mints the publishable key on insert (`GET /apps/{id}/status` returns
    # it) — it is simply no longer returned here, and no longer injected into the sandbox.
    assert app.app_key.startswith("bial_")  # a bial_ key, not a UUID

    env = build_app_env(app_id)
    assert env["BIAL_APP_ID"] == str(app_id)
    # The retired shared data plane's two vars are GONE — injecting them again would hand a
    # generated app a credential to a plane that no longer exists.
    assert "BIAL_APP_CREDENTIAL" not in env
    assert "BIAL_DATA_BASE_URL" not in env


async def test_repeat_build_reuses_row_and_key(db_session: AsyncSession) -> None:
    user = await UserFactory.create(db_session, email="c2@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    a1 = await resolve_app_for_project(db_session, user.id, project.id)
    row1 = await db_session.get(AppRegistry, a1)
    assert row1 is not None
    k1 = row1.app_key
    a2 = await resolve_app_for_project(db_session, user.id, project.id)
    row2 = await db_session.get(AppRegistry, a2)
    assert row2 is not None
    assert a1 == a2 and k1 == row2.app_key  # reused, not re-minted (continuity)


async def test_cross_user_project_is_404(db_session: AsyncSession) -> None:
    owner = await UserFactory.create(db_session, email="a@rvaiglobal.com")
    intruder = await UserFactory.create(db_session, email="b@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, owner.id)
    with pytest.raises(AppApiError) as exc:
        await resolve_app_for_project(db_session, intruder.id, project.id)
    assert exc.value.status_code == 404  # non-leaking


async def test_foreign_owned_app_is_409(db_session: AsyncSession) -> None:
    owner = await UserFactory.create(db_session, email="a2@rvaiglobal.com")
    other = await UserFactory.create(db_session, email="b2@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, owner.id)
    # An ownership-invariant violation: the project is the owner's, but its app is another
    # user's — the owner-guarded upsert WHERE matches nothing, so it fails closed with 409.
    await AppRegistryFactory.create(db_session, user_id=other.id, project_id=project.id)
    with pytest.raises(AppApiError) as exc:
        await resolve_app_for_project(db_session, owner.id, project.id)
    assert exc.value.status_code == 409


async def test_project_deleted_mid_upsert_maps_to_404(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The project passes the owner check, then is deleted before the INSERT lands -> the FK
    # violation on `app_registry_project_id_fkey` is the loser of that race, mapped to a
    # non-leaking 404 (never a 500). owned_project_or_404 uses db.get, so patching db.execute
    # only fails the upsert.
    user = await UserFactory.create(db_session, email="frace@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    async def boom_fkey(*_a: object, **_k: object) -> object:
        raise IntegrityError(
            "INSERT INTO app_registry ...",
            {},
            Exception(
                'insert or update violates foreign key constraint "app_registry_project_id_fkey"'
            ),
        )

    monkeypatch.setattr(db_session, "execute", boom_fkey)
    with pytest.raises(AppApiError) as exc:
        await resolve_app_for_project(db_session, user.id, project.id)
    assert exc.value.status_code == 404


async def test_unrelated_integrity_error_propagates(
    db_session: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A DIFFERENT integrity violation is NOT the project-deleted race -> it must propagate,
    # never be swallowed into a misleading 404.
    user = await UserFactory.create(db_session, email="frace2@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)

    async def boom_other(*_a: object, **_k: object) -> object:
        raise IntegrityError(
            "INSERT INTO app_registry ...",
            {},
            Exception('duplicate key value violates unique constraint "uq_app_registry_project"'),
        )

    monkeypatch.setattr(db_session, "execute", boom_other)
    with pytest.raises(IntegrityError):
        await resolve_app_for_project(db_session, user.id, project.id)


# --- the switched-off gate -------------------------------------------------------------
#
# ASSERTED HERE, AT THE SITE THAT DECIDES IT. This function is the ONE gate:
# `relaunch_preview` (the explicit start control) and `ensure_sandbox` — which the turn
# engine routes EVERY turn kind through — both resolve the project's app through it, so
# one refusal here closes both doors. `test_manager.py` pins that they really do arrive
# here; these pin the decision itself.


async def test_a_switched_off_app_refuses_to_resolve(db_session: AsyncSession) -> None:
    user = await UserFactory.create(db_session, email="killed@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    await AppRegistryFactory.create(
        db_session, user_id=user.id, project_id=project.id, status=AppStatus.DISABLED
    )
    with pytest.raises(AppApiError) as exc:
        await resolve_app_for_project(db_session, user.id, project.id)
    assert exc.value.status_code == 409
    # The machine-readable code the browser branches on: this refusal shares a status family
    # with the workspace CONFLICTS and has a different cause and no remedy to retry.
    assert exc.value.code == APP_SWITCHED_OFF_CODE
    # The sentence the citizen reads says what they cannot do, and says it WITHOUT mentioning
    # publishing — a never-published draft can be switched off too, and its owner learns
    # nothing from being told that publishing is blocked.
    assert "cannot make changes" in exc.value.message
    assert "publish" not in exc.value.message.lower()


@pytest.mark.parametrize(
    "status", [AppStatus.DRAFT, AppStatus.PENDING, AppStatus.APPROVED, AppStatus.REJECTED]
)
async def test_every_other_status_still_resolves(
    db_session: AsyncSession, status: AppStatus
) -> None:
    """The gate is narrow on purpose: DISABLED is the only status that stops the workspace.

    A pending app is mid-review and its owner keeps working; a rejected one is being fixed,
    which is the whole point of a rejection note. Widening this would take the workspace away
    from the two groups most likely to need it.
    """
    user = await UserFactory.create(db_session, email=f"ok-{status.value}@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    row = await AppRegistryFactory.create(
        db_session, user_id=user.id, project_id=project.id, status=status
    )
    assert await resolve_app_for_project(db_session, user.id, project.id) == row.id


@pytest.mark.route_rollback
async def test_the_refused_resolve_leaves_the_row_alone(db_session: AsyncSession) -> None:
    """A refusal is not a write. The upsert's DO-UPDATE bumps `updated_at` before the status
    comes back, and the caller owns the commit — every one of them raises straight past it —
    so nothing the refused request touched may survive. Rolled back here the way `get_db`
    rolls it back in a request."""
    user = await UserFactory.create(db_session, email="killed2@rvaiglobal.com")
    project = await ProjectFactory.create(db_session, user.id)
    row = await AppRegistryFactory.create(
        db_session, user_id=user.id, project_id=project.id, status=AppStatus.DISABLED
    )
    await db_session.commit()
    # Re-read rather than project off the just-inserted object: `updated_at` is a server
    # default, and a new row has not loaded it yet. The id is held in a plain local because
    # the rollback below expires every instance attribute.
    await db_session.refresh(row)
    app_id, stamped = row.id, row.updated_at

    with pytest.raises(AppApiError):
        await resolve_app_for_project(db_session, user.id, project.id)
    await db_session.rollback()

    fresh = await db_session.get(AppRegistry, app_id)
    assert fresh is not None
    await db_session.refresh(fresh)
    assert fresh.status is AppStatus.DISABLED
    assert fresh.updated_at == stamped  # the speculative bump never landed


def test_build_app_env_normalizes_portal_origin(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "sandbox", _sandbox_config())
    monkeypatch.setattr(settings, "FRONTEND_URL", "https://portal.example.com/app/")
    env = build_app_env(uuid.uuid4())
    # A FRONTEND_URL with a path / trailing slash is normalized to a bare origin.
    assert env["BIAL_PORTAL_ORIGIN"] == "https://portal.example.com"
    # No name ends in a scrub-triggering suffix.
    for name in env:
        assert not name.endswith(("_TOKEN", "_SECRET", "_KEY"))


def test_build_app_env_requires_configured_sandbox(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "sandbox", None)
    with pytest.raises(SandboxNotConfiguredError):
        build_app_env(uuid.uuid4())
