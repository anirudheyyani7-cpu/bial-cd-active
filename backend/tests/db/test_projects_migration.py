"""Projects schema round-trips + constraints against the REAL migrated schema (revision
0015_projects, via `alembic upgrade head`), inside a rolled-back per-test transaction — no
data migration.

The upgrade/downgrade round-trip itself is verified out-of-band and guarded against a second
head by `tests/test_alembic_single_head.py`; here we prove the shape the migration produced
is correct.
"""

from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from src.db.models.app_registry import AppRegistry, mint_app_key
from src.db.models.conversation import ChatKind, Conversation
from src.db.models.project import Project
from tests.factories import (
    AppRegistryFactory,
    ConversationFactory,
    ProjectFactory,
    UserFactory,
)


async def test_project_roundtrip_defaults(db_session) -> None:
    user = await UserFactory.create(db_session)
    project = ProjectFactory.build(user.id, name="VIP Movement")
    db_session.add(project)
    await db_session.flush()
    await db_session.refresh(project)

    assert project.id.version == 7  # UUIDv7 PK
    assert project.name == "VIP Movement"
    assert project.description is None  # optional, no default
    assert project.created_at is not None

    fetched = await db_session.scalar(select(Project).where(Project.id == project.id))
    assert fetched is not None
    assert fetched.user_id == user.id


async def test_app_registry_project_id_not_null(db_session) -> None:
    user = await UserFactory.create(db_session)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(AppRegistry(user_id=user.id, app_key=mint_app_key()))
            await db_session.flush()


async def test_conversation_project_id_not_null(db_session) -> None:
    user = await UserFactory.create(db_session)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(Conversation(id=uuid.uuid4(), user_id=user.id, kind=ChatKind.PLAN))
            await db_session.flush()


async def test_one_app_per_project_enforced(db_session) -> None:
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    await AppRegistryFactory.create(db_session, user_id=user.id, project_id=project.id)
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            db_session.add(
                AppRegistry(user_id=user.id, app_key=mint_app_key(), project_id=project.id)
            )
            await db_session.flush()


async def test_no_redundant_project_id_index(db_session) -> None:
    # uq_app_registry_project's unique index already covers project_id lookups;
    # the redundant non-unique ix_app_registry_project_id must not exist (or creep back).
    names = (
        await db_session.execute(
            text("SELECT indexname FROM pg_indexes WHERE tablename = 'app_registry'")
        )
    ).scalars()
    index_names = set(names)
    assert "ix_app_registry_project_id" not in index_names
    assert "uq_app_registry_project" in index_names


async def test_old_owner_conversation_uniqueness_dropped(db_session) -> None:
    # The old uq_app_registry_owner_conversation is gone: two apps may share a
    # (user_id, conversation_id) as long as they live in DIFFERENT projects.
    user = await UserFactory.create(db_session)
    shared_conv = uuid.uuid4()
    p1 = await ProjectFactory.create(db_session, user.id)
    p2 = await ProjectFactory.create(db_session, user.id)
    await AppRegistryFactory.create(
        db_session, user_id=user.id, project_id=p1.id, conversation_id=shared_conv
    )
    # Would have violated the old constraint; now permitted (different project).
    await AppRegistryFactory.create(
        db_session, user_id=user.id, project_id=p2.id, conversation_id=shared_conv
    )


async def test_current_code_jsonb_roundtrip(db_session) -> None:
    user = await UserFactory.create(db_session)
    snapshot = {"current": {"source": "export default () => null", "entry": "PreviewApp"}}
    app = await AppRegistryFactory.create(db_session, user_id=user.id, current_code=snapshot)
    fetched = await db_session.get(AppRegistry, app.id)
    assert fetched is not None
    assert fetched.current_code == snapshot


async def test_delete_project_cascades_children(db_session) -> None:
    # DB-level ON DELETE CASCADE removes the project's app + conversations (the row
    # backstop — blob-aware cleanup is a separate service's job).
    user = await UserFactory.create(db_session)
    project = await ProjectFactory.create(db_session, user.id)
    app = await AppRegistryFactory.create(db_session, user_id=user.id, project_id=project.id)
    conv = await ConversationFactory.create(db_session, user.id, project_id=project.id)

    await db_session.delete(project)
    await db_session.flush()

    assert await db_session.scalar(select(AppRegistry).where(AppRegistry.id == app.id)) is None
    assert await db_session.scalar(select(Conversation).where(Conversation.id == conv.id)) is None
