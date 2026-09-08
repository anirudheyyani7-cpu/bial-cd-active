"""`app_registry.previous_status` against the REAL migrated schema.

The test DB carries the column from `alembic upgrade head` (revision
0038_app_previous_status), so the shape assertions exercise the actual DDL — the existing
native `app_status` enum, nullable, no default — inside the rolled-back per-test transaction.
`test_suspended_at_migration.py` pins the chain's exact head at 0038 and
`tests/test_alembic_single_head.py` guards the head count.

DELIBERATELY NO downgrade/upgrade round-trip, following 0030 and 0032: every round-trip on
`app_registry` permanently burns pg_attribute slots on the shared test database (a dropped
column never frees its attnum, ~1600 per table ever), and that table is the one already close
to its budget. The backfill is tested instead by importing the migration module and executing
EXACTLY the statement `upgrade()` runs (`BACKFILL_ALREADY_DISABLED`) over ORM-seeded rows —
the fresh-upgrade DDL path is what built this database in the first place.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType

import sqlalchemy as sa

from src.db.models.app_registry import AppRegistry, AppStatus
from tests.factories import AppRegistryFactory, ProjectFactory, UserFactory

_BACKEND_ROOT = Path(__file__).resolve().parent.parent.parent
_MIGRATION_PATH = _BACKEND_ROOT / "alembic" / "versions" / "2026_09_07_0038_app_previous_status.py"


def _migration_module() -> ModuleType:
    """Import the 0038 migration BY PATH (the versions dir is not a package), so the backfill
    tests run the statement the migration itself runs — never a copy that could drift."""
    spec = importlib.util.spec_from_file_location("migration_0038", _MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _app(db, email: str, **overrides) -> AppRegistry:
    user = await UserFactory.create(db, email=email)
    project = await ProjectFactory.create(db, user.id)
    return await AppRegistryFactory.create(db, user_id=user.id, project_id=project.id, **overrides)


# --- shape: the DDL the fresh upgrade applied ------------------------------------


async def test_the_column_is_the_native_enum_nullable_with_no_default(db_session) -> None:
    """Three properties, each a decision rather than a default.

    NATIVE ENUM, not a varchar with a check — it holds a status, and the type that
    already exists is the one that should hold it. NULLABLE, because the absence of a value
    carries meaning here: an app that is not switched off has nothing to remember. And NO
    SERVER DEFAULT, for the same reason — there is nothing for a default to say, and one would
    turn "not switched off" into a lie about what the app used to be.
    """
    row = (
        await db_session.execute(
            sa.text(
                "SELECT data_type, udt_name, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_name = 'app_registry' AND column_name = 'previous_status'"
            )
        )
    ).one()
    assert row.data_type == "USER-DEFINED"
    assert row.udt_name == "app_status"  # the EXISTING type, not a second one
    assert row.is_nullable == "YES"
    assert row.column_default is None


# --- the backfill: exactly the statement `upgrade()` runs -------------------------


async def test_a_row_already_disabled_when_this_shipped_backfills_to_approved(
    db_session,
) -> None:
    """THE BEHAVIOUR-PRESERVING CHOICE, asserted rather than assumed.

    Rows already disabled at cutover have nothing to have remembered, and they are precisely
    the ones an administrator is most likely to re-enable next — so leaving them undefined
    would make the first use of the new code the one that breaks. `approved` is what the code
    being replaced resolved every re-enable to, so for every pre-column row enable does
    exactly what it did the day before.
    """
    row = await _app(
        db_session,
        "backfill-off@rvaiglobal.com",
        status=AppStatus.DISABLED,
        previous_status=None,
    )
    await db_session.flush()

    await db_session.execute(_migration_module().BACKFILL_ALREADY_DISABLED)

    await db_session.refresh(row)
    assert row.previous_status is AppStatus.APPROVED


async def test_the_backfill_leaves_every_app_that_is_not_switched_off_alone(
    db_session,
) -> None:
    """A live app has nothing to remember, and inventing a memory for one would make a later
    disable/enable round trip return it to a status it was never in."""
    live = await _app(db_session, "backfill-live@rvaiglobal.com", status=AppStatus.DRAFT)
    await db_session.flush()

    await db_session.execute(_migration_module().BACKFILL_ALREADY_DISABLED)

    await db_session.refresh(live)
    assert live.previous_status is None


async def test_the_backfill_is_idempotent_and_never_overwrites_a_real_memory(
    db_session,
) -> None:
    """`previous_status IS NULL` is what makes a re-run safe — and, more importantly, what
    stops a re-run rewriting a switched-off DRAFT's real memory to `approved` and inventing
    the approval this whole column exists to avoid inventing."""
    remembered = await _app(
        db_session,
        "backfill-remembered@rvaiglobal.com",
        status=AppStatus.DISABLED,
        previous_status=AppStatus.DRAFT,
    )
    await db_session.flush()

    statement = _migration_module().BACKFILL_ALREADY_DISABLED
    await db_session.execute(statement)
    await db_session.execute(statement)  # run twice: the migration must survive a re-run

    await db_session.refresh(remembered)
    assert remembered.previous_status is AppStatus.DRAFT
