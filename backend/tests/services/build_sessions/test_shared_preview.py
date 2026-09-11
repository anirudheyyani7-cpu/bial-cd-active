"""`SessionManager.launch_shared_preview` / `revoke_shared_preview` (#198 slice 3) — a
colleague's read-only door into the one-per-user slot `relaunch_preview` uses for a builder's
own project.

Driven by FakeSandboxClient + fakeredis + fake storage + the `:5432` test DB, the same harness
`test_manager.py::test_relaunch_*` uses for the method this one mirrors — go there for the
attach/cold-restore/readiness-failure state machine's own exhaustive coverage; these tests are
about what is DIFFERENT for a shared view: whose slot it occupies, which snapshot it may ever
restore from, and how it tags the container it mints.
"""

from __future__ import annotations

import uuid

import pytest
import redis.asyncio as aioredis
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.project import Project
from src.db.models.user import User
from src.services.build_sessions.appdata import resolve_app_for_project
from src.services.build_sessions.locks import lock_is_held
from src.services.build_sessions.manager import (
    BuildSessionConflictError,
    NoSnapshotToRelaunchError,
    SessionManager,
    shr_name_for,
)
from src.services.sandbox import SandboxHandle
from src.services.storage import recovery_key, snapshot_key
from tests.factories import ProjectFactory, UserFactory
from tests.fakes import FakeSandboxClient, FakeStorage


async def _owner_with_saved_app(
    db: AsyncSession, store: FakeStorage, *, email: str
) -> tuple[User, Project, uuid.UUID]:
    owner = await UserFactory.create(db, email=email)
    project = await ProjectFactory.create(db, owner.id, description="A shared project")
    app_id = await resolve_app_for_project(db, owner.id, project.id)
    await db.commit()
    await db.refresh(project)
    await store.put(snapshot_key(app_id), b"BUNDLE")
    return owner, project, app_id


async def test_launch_cold_restores_and_returns_the_owners_app_id(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner1@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient1@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()

    preview = await manager.launch_shared_preview(db_session, recipient, project, client)

    shared_name = shr_name_for(app_id, recipient.id)
    assert preview.app_id == app_id  # the OWNER's app id, never the recipient's
    assert client.restored == [shared_name]
    assert client.provisioned == []  # never a blank template
    assert preview.ready is True
    assert await lock_is_held(fake_redis, recipient.id) is False  # lock released, slot free


async def test_launch_never_restores_the_owners_recovery_bundle(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    """Requirement 21, pinned directly: a shared view is restored from the owner's last
    deliberate Save, never their crash-recovery bundle — even when one exists and is newer."""
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner2@example.com"
    )
    await fake_storage.put(recovery_key(app_id), b"NEWER, BUT NEVER THE ANSWER")
    recipient = await UserFactory.create(db_session, email="recipient2@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()

    await manager.launch_shared_preview(db_session, recipient, project, client)

    assert client.restored_from == [snapshot_key(app_id)]


async def test_the_restored_container_is_tagged_as_a_shared_sandbox(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner3@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient3@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()

    await manager.launch_shared_preview(db_session, recipient, project, client)

    assert client.restored_as_kind == ["shared_sandbox"]


async def test_launch_attaches_to_an_already_live_shared_view(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner4@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient4@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()
    first = await manager.launch_shared_preview(db_session, recipient, project, client)

    # Re-attach: point the fake at itself as an already-live container under the same name.
    shared_name = shr_name_for(app_id, recipient.id)
    client.attach_handle = SandboxHandle(
        fqdn=f"{shared_name}.example",
        token="tok",  # noqa: S106 - a fake, never a real bearer
        app_name=shared_name,
        preview_url=first.preview_url,
        ready=True,
    )
    second = await manager.launch_shared_preview(db_session, recipient, project, client)

    assert client.restored == [shared_name]  # only ONE restore — the second call attached
    assert second.app_id == app_id


async def test_refresh_always_restores_even_when_already_live(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    """Requirement 22: Refresh moves the served snapshot forward even when a live view is
    already up — unlike Launch, it never treats an already-attached container as good enough."""
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner5@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient5@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()
    await manager.launch_shared_preview(db_session, recipient, project, client)

    await manager.launch_shared_preview(db_session, recipient, project, client, force_refresh=True)

    shared_name = shr_name_for(app_id, recipient.id)
    assert client.restored == [shared_name, shared_name]  # restored TWICE, not attached once


async def test_launch_with_no_saved_snapshot_is_a_dead_end_404(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner = await UserFactory.create(db_session, email="owner6@example.com")
    project = await ProjectFactory.create(db_session, owner.id, description="Never saved")
    await resolve_app_for_project(db_session, owner.id, project.id)
    await db_session.commit()
    await db_session.refresh(project)
    recipient = await UserFactory.create(db_session, email="recipient6@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()

    with pytest.raises(NoSnapshotToRelaunchError):
        await manager.launch_shared_preview(db_session, recipient, project, client)

    assert client.provisioned == []
    assert client.restored == []
    assert await lock_is_held(fake_redis, recipient.id) is False


async def test_launch_refuses_while_the_recipient_is_mid_build_on_their_own_project(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner7@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient7@example.com")
    recipient_project = await ProjectFactory.create(
        db_session, recipient.id, description="Recipient's own project"
    )
    manager = SessionManager()
    build_client = FakeSandboxClient()
    await manager.ensure_sandbox(
        db_session, recipient, recipient_project.id, sandbox_client=build_client, may_write=True
    )

    with pytest.raises(BuildSessionConflictError):
        await manager.launch_shared_preview(db_session, recipient, project, FakeSandboxClient())


async def test_revoke_tears_down_a_live_shared_view(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner8@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient8@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()
    await manager.launch_shared_preview(db_session, recipient, project, client)
    shared_name = shr_name_for(app_id, recipient.id)

    revoked = await manager.revoke_shared_preview(recipient.id, app_id, sandbox_client=client)

    assert revoked is True
    assert shared_name in client.torn_down
    assert await lock_is_held(fake_redis, recipient.id) is False


async def test_revoke_is_a_noop_when_nothing_is_there(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner9@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient9@example.com")
    manager = SessionManager()
    client = FakeSandboxClient()

    revoked = await manager.revoke_shared_preview(recipient.id, app_id, sandbox_client=client)

    assert revoked is False
    assert client.torn_down == []


async def test_revoke_never_touches_the_recipients_own_build(
    db_session: AsyncSession, fake_redis: aioredis.Redis, fake_storage: FakeStorage
) -> None:
    """The container-identity check is the whole safety property here: revoking access to
    project A must never tear down a container the recipient is using for project B, whether
    that is their own build or a DIFFERENT colleague's shared view."""
    owner, project, app_id = await _owner_with_saved_app(
        db_session, fake_storage, email="owner10@example.com"
    )
    recipient = await UserFactory.create(db_session, email="recipient10@example.com")
    recipient_project = await ProjectFactory.create(
        db_session, recipient.id, description="Recipient's own, unrelated project"
    )
    manager = SessionManager()
    build_client = FakeSandboxClient()
    session = await manager.ensure_sandbox(
        db_session, recipient, recipient_project.id, sandbox_client=build_client, may_write=True
    )
    await manager._finalize(session, "completed", build_client)  # noqa: SLF001 - pardons it

    revoked = await manager.revoke_shared_preview(
        recipient.id, app_id, sandbox_client=build_client
    )

    assert revoked is False
    assert build_client.torn_down == []
