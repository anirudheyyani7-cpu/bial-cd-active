"""app_registry.previous_status — what the app was before the kill switch (#163, R42)

`disable` now reaches DRAFT and REJECTED apps as well as APPROVED ones (migration-free, the
transition table widened in code). `enable` did not follow: it resolved every re-enable to the
literal APPROVED, which on a never-approved app INVENTS AN APPROVAL NOBODY GAVE, and — once the
approved-submission guard refuses a row with no pin — strands a switched-off draft or rejected
app in DISABLED with no way out. This column is the memory that makes the return trip honest:
`disable` records the pre-disable status, `enable` restores it and clears the column.

WHY A COLUMN AND NOT A WIDER TRANSITION TABLE. The obvious repair is to let `disabled → draft`
by adding DISABLED to `STATUS_TRANSITIONS[DRAFT]`. Do not: `apps/router.py::withdraw` is
CITIZEN-facing and reads that same row with only an ownership predicate, so widening it would
let the OWNER of an app an administrator switched off walk it straight back to draft.
Containment would become a bypass. The status a re-enable must land on is a fact about this one
row, not a new edge in the state machine, so it is stored as one.

NULLABLE, AND NULL IS NOT AN ERROR — it is one of two ordinary states. An app that is not
switched off has nothing to remember (`enable` nulls this on the way back out). And a row that
was ALREADY DISABLED when this shipped has nothing to have remembered.

THE BACKFILL IS THE BEHAVIOUR-PRESERVING CHOICE, and rows already disabled are precisely the
ones an administrator is most likely to re-enable next — so leaving them undefined would make
the first use of the new code the one that breaks. They are set to `approved`: the status the
code being replaced would have resolved them to anyway. So for every row that predates this
column, enable does exactly what it did yesterday. `enable` ALSO reads a NULL as `approved`,
for the same reason and as the backstop — a row inserted by hand during an incident, or one
this backfill somehow missed, must not error on a null.

NO SERVER DEFAULT. Unlike `rejection_standing` (0032), the absence of a value here carries
meaning — "this app is not switched off" — so there is nothing for a default to say, and the
column is nullable rather than NOT NULL for exactly that reason. Adding a nullable column with
no default is metadata-only on PG11+: no rewrite, no lock of consequence.

NO DOWNGRADE/UPGRADE ROUND-TRIP TEST, following 0030 and 0032: a round trip on `app_registry`
burns pg_attribute slots on the shared test database forever (see
`docs/solutions/test-failures/alembic-round-trip-tests-burn-attnum-slots-2026-07-20.md`), and
that table is the one already close to its budget. The backfill is exercised directly instead.

Revision ID: 0038_app_previous_status
Revises: 0037_deleted_project_description
Create Date: 2026-09-07

Hand-finalized (ADR-0013).
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0038_app_previous_status"
down_revision: str | None = "0037_deleted_project_description"
branch_labels: str | None = None
depends_on: str | None = None

_TABLE = "app_registry"
_COLUMN = "previous_status"

# The EXISTING native `app_status` enum (ADR-0008), referenced not created: `create_type=False`
# is what stops this migration emitting a second CREATE TYPE for a type migration 0001 already
# owns — the same convention 0030 and 0035 use, and the same one the model's shared
# `app_status_enum` carries.
app_status = postgresql.ENUM(
    "draft",
    "pending",
    "approved",
    "rejected",
    "disabled",
    name="app_status",
    create_type=False,
)

# As ONE statement so the test suite can execute EXACTLY what runs here (0032's convention).
# `previous_status IS NULL` keeps it idempotent; `status = 'disabled'` is the whole of what is
# knowable at cutover — a row's pre-disable status left no durable trace, which is the very
# defect this column exists to fix, so `approved` is chosen because it is what the code being
# replaced resolved to and not because anything recorded it.
BACKFILL_ALREADY_DISABLED = sa.text(
    "UPDATE app_registry SET previous_status = 'approved' "
    "WHERE status = 'disabled' AND previous_status IS NULL"
)


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column(_COLUMN, app_status, nullable=True))
    op.execute(BACKFILL_ALREADY_DISABLED)


def downgrade() -> None:
    op.drop_column(_TABLE, _COLUMN)
