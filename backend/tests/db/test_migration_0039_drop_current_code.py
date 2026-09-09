"""`app_registry.current_code` is gone against the REAL migrated schema (#191).

The test DB carries the drop from `alembic upgrade head` (revision
0039_drop_current_code), so this exercises the actual DDL rather than the ORM model
alone — the column disappearing from `app_registry` is what the drop actually did,
independent of whether `AppRegistry` still declares the attribute.
`test_suspended_at_migration.py` pins the chain's exact head at 0039 and
`tests/test_alembic_single_head.py` guards the head count.

DELIBERATELY NO downgrade/upgrade round-trip against the shared test database, following
0038's own precedent (and 0030/0032 before it): every round-trip on `app_registry`
permanently burns pg_attribute slots (a dropped column never frees its attnum, ~1600 per
table ever), and that table is the one already closest to its budget. The structure-only
add-back on downgrade is exercised out-of-band instead
(`tests/db/test_migration_downgrade.py` marks its own destructive round-trip
`pytest.mark.destructive_migration`, run before shipping a migration, never in the default
lane).
"""

from __future__ import annotations

import sqlalchemy as sa

from src.db.models.app_registry import AppRegistry


async def test_current_code_is_gone_from_the_live_schema(db_session) -> None:
    row = (
        await db_session.execute(
            sa.text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'app_registry' AND column_name = 'current_code'"
            )
        )
    ).one_or_none()
    assert row is None


def test_the_orm_model_no_longer_declares_the_column() -> None:
    # A belt-and-braces check alongside the live-schema one above: a model that still
    # mapped `current_code` after the column was dropped would fail on first read with an
    # opaque `UndefinedColumn`, not a clear "you forgot to update the model" message.
    assert "current_code" not in AppRegistry.__table__.columns
