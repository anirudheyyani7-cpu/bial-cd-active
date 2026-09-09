"""`projects.description_embedding` — the semantic-search index (#191 slice 3)

Revision ID: 0040_description_embedding
Revises: 0039_drop_current_code
Create Date: 2026-09-08

SHORTENED FROM THE ORIGINALLY-AUTHORED "0040_project_description_embedding": that form is 34
characters, two over `alembic_version.version_num`'s `VARCHAR(32)` — `alembic upgrade head`
fails with "value too long for type character varying(32)" at exactly this revision, not at
authoring time, so nothing catches it before a real migration run does (review of #191,
agc129). Filename renamed to match, mirroring every other migration in this chain.

A nullable `vector(1536)` column, populated from the write path (`api/v1/projects/router.py`)
whenever a description is first set or changes — never derived by Postgres, unlike
`description_tsv` (0034), because the embedding call is a network round trip a GENERATED
column cannot make. 1536 is `text-embedding-3-small`'s default dimension count and sits under
pgvector's 2000-dimension ceiling for both HNSW and IVFFlat, so an index stays available.

NULLABLE FOR THE SAME REASON `description` ITSELF IS (KD-8/#191 R13): a row with no embedding
(every pre-#191 project, or one whose embedding call failed — R26) is not an error state, it
is keyword-only for that row, which the hybrid search query already treats as a normal case
rather than special-casing.

HNSW, COSINE OPS: OpenAI embeddings are compared by cosine similarity, and HNSW is pgvector's
recommended index for query-time recall at this scale (the marketplace catalog is sized at
10-200 rows per #145/#191 — small enough that an IVFFlat's build-time list-count tuning buys
nothing an HNSW default doesn't already give for free).

LOCKING, mirroring 0034's discipline for the same reason: `CREATE INDEX` (not CONCURRENTLY)
takes a SHARE lock — blocking writes — while it builds, and `projects` is not the 10-200-row
marketplace catalog, it is every user's every project. Unlike 0034's GENERATED tsvector
column, a plain nullable `ADD COLUMN` here IS the metadata-only fast path (no ACCESS EXCLUSIVE
rewrite), so only the index build needs the guard below.

DEPLOY-ORDERING HAZARD, same shape as 0034's: this column must exist before the image that
writes to it ships — migrate first, THEN deploy; roll back in the reverse order.
"""

from collections.abc import Sequence

import sqlalchemy as sa
from pgvector.sqlalchemy import Vector

from alembic import op

revision: str = "0040_description_embedding"
down_revision: str | Sequence[str] | None = "0039_drop_current_code"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_INDEX = "ix_projects_description_embedding"
_EMBEDDING_DIMENSIONS = 1536


def upgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.add_column(
        "projects",
        sa.Column("description_embedding", Vector(_EMBEDDING_DIMENSIONS), nullable=True),
    )
    op.execute(
        f"""
        CREATE INDEX {_INDEX} ON projects
        USING hnsw (description_embedding vector_cosine_ops)
        """
    )
    op.execute("SET LOCAL lock_timeout = DEFAULT")


def downgrade() -> None:
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.execute(f"DROP INDEX IF EXISTS {_INDEX}")
    op.drop_column("projects", "description_embedding")
    op.execute("SET LOCAL lock_timeout = DEFAULT")
