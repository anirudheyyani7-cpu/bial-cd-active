"""`projects.description_embedding` against the REAL migrated schema (#191 slice 3).

The autogenerate-drift check that would catch a `__table_args__`/migration mismatch already
exists and runs against the FULL current schema — `test_migration_0034_marketplace_indexes.py
::test_autogenerate_against_the_migrated_schema_is_empty` — so it is not duplicated here; this
file only pins what is specific to 0040: the column's own shape, the index's algorithm and
operator class, and the same lock_timeout discipline 0034 established.
"""

from __future__ import annotations

import pathlib

import sqlalchemy as sa

_INDEX = "ix_projects_description_embedding"
MIGRATION_PATH = (
    pathlib.Path(__file__).resolve().parents[2]
    / "alembic"
    / "versions"
    / "2026_09_08_0040_description_embedding.py"
)


async def test_the_column_is_a_nullable_vector_with_no_default(db_session) -> None:
    row = (
        await db_session.execute(
            sa.text(
                "SELECT data_type, udt_name, is_nullable, column_default "
                "FROM information_schema.columns "
                "WHERE table_name = 'projects' AND column_name = 'description_embedding'"
            )
        )
    ).one()
    assert row.udt_name == "vector"
    assert row.is_nullable == "YES"
    assert row.column_default is None


async def test_the_vector_column_is_dimensioned_at_1536(db_session) -> None:
    # `atttypmod` on a pgvector column carries the declared dimension count directly (not
    # the usual varchar-style `length + 4` encoding), so this is a plain equality check.
    dim = await db_session.scalar(
        sa.text(
            "SELECT a.atttypmod FROM pg_attribute a "
            "JOIN pg_class c ON a.attrelid = c.oid "
            "WHERE c.relname = 'projects' AND a.attname = 'description_embedding'"
        )
    )
    assert dim == 1536


async def test_the_index_is_hnsw_with_cosine_ops(db_session) -> None:
    indexdef = await db_session.scalar(
        sa.text("SELECT indexdef FROM pg_indexes WHERE indexname = :name"),
        {"name": _INDEX},
    )
    assert indexdef is not None, f"{_INDEX} does not exist"
    assert "USING hnsw" in indexdef, indexdef
    assert "vector_cosine_ops" in indexdef, indexdef


def test_both_halves_of_the_migration_reset_lock_timeout() -> None:
    # Same regression 0034 guards against, source-level for the same reason (see that file's
    # own docstring): `SET LOCAL lock_timeout` is transaction-scoped, and `alembic/env.py`
    # runs every pending revision in one transaction, so an unreset guard leaks into whatever
    # migration lands after this one in the same `alembic upgrade`.
    source = MIGRATION_PATH.read_text(encoding="utf-8")
    upgrade_src = source[source.index("def upgrade()") : source.index("def downgrade()")]
    downgrade_src = source[source.index("def downgrade()") :]

    for name, body in (("upgrade", upgrade_src), ("downgrade", downgrade_src)):
        assert "SET LOCAL lock_timeout = '5s'" in body, (
            f"{name}() no longer sets a lock_timeout, so its DDL can queue behind an open "
            "reader and block every request for that table"
        )
        assert "SET LOCAL lock_timeout = DEFAULT" in body, (
            f"{name}() no longer RESETS lock_timeout, which leaks into every later revision "
            "in the same `alembic upgrade` (transaction_per_migration is False)"
        )
        assert body.index("SET LOCAL lock_timeout = '5s'") < body.index(
            "SET LOCAL lock_timeout = DEFAULT"
        ), f"{name}() resets lock_timeout before its DDL, so the guard covers nothing"
