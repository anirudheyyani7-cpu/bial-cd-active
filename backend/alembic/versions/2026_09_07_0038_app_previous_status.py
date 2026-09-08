"""app_registry.previous_status — what the app was before the kill switch

Revision ID: 0038_app_previous_status
Revises: 0037_deleted_project_description
Create Date: 2026-09-07

WHY THIS EXISTS: `disable` now reaches DRAFT and REJECTED apps as well as APPROVED ones
(migration-free, the transition table widened in code), but `enable` did not follow — it
resolved every re-enable to the literal APPROVED, inventing an approval nobody gave and, once
the approved-submission guard refuses a row with no pin, stranding a switched-off draft or
rejected app in DISABLED with no way out. This column remembers the pre-disable status so the
round trip stays honest: `disable` records it, `enable` restores it and clears the column.

A COLUMN, NOT A WIDER TRANSITION TABLE: adding DISABLED to `STATUS_TRANSITIONS[DRAFT]` is
rejected because `apps/router.py::withdraw` is CITIZEN-facing and reads the same row on an
ownership predicate alone, so widening the table would let the owner of an app an administrator
switched off walk it back to draft — containment becoming a bypass. The re-enable status is a
fact about this one row, not a new state-machine edge, so it is stored as one.

NULL IS NOT AN ERROR: an app not switched off has nothing to remember (nulled on the way out),
and a row already disabled when this shipped has nothing to have remembered — yet those are the
rows an administrator is most likely to re-enable next, so leaving them undefined would make the
first use of the new code the one that breaks. THE BACKFILL sets them to `approved`, the status
the replaced code would have resolved them to anyway, so enable does for every pre-column row
exactly what it did yesterday. `enable` reads a bare NULL the same way, the backstop for a row
inserted by hand during an incident or missed by the backfill: a null must not error.

NO SERVER DEFAULT: unlike `rejection_standing` (0032), an absent value here means something —
"not switched off" — so there is nothing for a default to say; a nullable column with none is
metadata-only on PG11+ (no rewrite, no lock).

NO DOWNGRADE/UPGRADE ROUND-TRIP TEST, following 0030 and 0032: a round trip on `app_registry`
burns pg_attribute slots on the shared test database forever, and that table is the one already
close to its budget, so the backfill is exercised directly instead.

Hand-finalized.
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

# The EXISTING native `app_status` enum, referenced not created: `create_type=False`
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
