"""deleted_projects.project_description — what the app WAS, kept past the cascade (#184)

An administrator reading a deletion gets the project's name, its owner, who deleted it and
why. It does not get the one sentence that says what the thing actually did, so a row reading
"Visitor Log" is legible without being informative. This adds the description the citizen
wrote, copied onto the tombstone exactly as `project_name` already is.

WHY A COPY AND NOT A LOOKUP: the description lives on the `projects` row that
`delete_project_cascade` deletes in the same transaction that writes this record, and it
exists in no second copy — `description_tsv` (migration 0034) is a lossy `to_tsvector` of it,
not the text. So the value is read into the record BEFORE the cascade runs; a record written
afterwards has nothing left to read.

NOT NULL WITH AN EMPTY DEFAULT rather than nullable, matching `chats_deleted`'s reasoning on
this table: to the administrator reading it, "this project had no description" and "we did not
record one" are different facts, and a NULL cannot tell them apart. `projects.description` is
nullable (NULL = none, normalized at the write boundary), so the copy coalesces to ''.

ROWS DELETED BEFORE THIS SHIPPED CANNOT BE BACKFILLED and are accepted as lost: the project
row their description lived on is already gone. They take the '' the server default gives
them, which is indistinguishable from a project that genuinely had no description. That is a
one-off loss bounded by the tombstones already written, and there is no source to repair it
from.

Revision ID: 0037_deleted_project_description
Revises: 0036_deleted_projects
"""

from __future__ import annotations

import sqlalchemy as sa

from alembic import op

revision: str = "0037_deleted_project_description"
down_revision: str | None = "0036_deleted_projects"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "deleted_projects"
_COLUMN = "project_description"


def upgrade() -> None:
    # The server default is what makes this a fast, non-rewriting ALTER on a NOT NULL column
    # (PG11+ stores it as an attribute default rather than rewriting the heap) AND what gives
    # the already-written tombstones a legal value. It is KEPT rather than dropped after the
    # add, mirroring `chats_deleted`/`had_app`: the column's meaning is "nothing recorded here
    # reads as empty", and an insert that omits it should get that rather than fail.
    op.add_column(
        _TABLE,
        sa.Column(_COLUMN, sa.Text(), nullable=False, server_default=""),
    )


def downgrade() -> None:
    op.drop_column(_TABLE, _COLUMN)
