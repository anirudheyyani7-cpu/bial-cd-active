"""approval lineage + submitted declaration on app_registry

Revision ID: 0030_approval_route_declaration
Revises: 0029_classification_reviews
Create Date: 2026-08-19

Two nullable columns on `app_registry`: `approval_route` (native enum `runbook`|`self_publish`)
records which LINEAGE the submission entered through — explicit because `redeploy_needed`
derives from two columns a self-published app never sets, so without it that app would read
"Deploy needed" forever. `declaration` is the JSONB publish-flow payload (both answer sets,
per-question diffs, redacted explanation) — JSONB for the same reason
`deployments.classification` (0026) is: the questionnaire is expected to be reworded.

WHY THIS EXISTS: BACKFILL marks every approved row, and every PENDING row, `runbook`. Approvals
are obvious — they were an out-of-band review, never a self-publish decision. PENDING is the
one easy to miss: a queue item outstanding at release has no lineage, so approving it would
leave `approval_route` NULL, fail the gate's rule 3, and force a second approval. Marking it
`runbook` turns that into a NAMED dead end (approve refuses, tells the admin to re-submit)
instead of a silent loop. Drafts and never-approved rejects stay NULL and pick up
`self_publish` on their first trip through publish.

`downgrade` just drops the columns + enum — nothing to "undo," every backfilled value lives
in a column the downgrade removes. Hand-finalized.
"""

from __future__ import annotations

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

# One char under alembic_version's varchar(32) — "and" did not survive the cap.
revision: str = "0030_approval_route_declaration"
down_revision: str | None = "0029_classification_reviews"
branch_labels: str | None = None
depends_on: str | None = None

# The native approval_route enum. create_type=False so THIS migration owns
# the lifecycle: explicit .create() in upgrade, .drop() in downgrade.
approval_route = postgresql.ENUM(
    "runbook",
    "self_publish",
    name="approval_route",
    create_type=False,
)

# The runbook-lineage backfill, as ONE statement so the test suite can exercise EXACTLY
# what runs here (the non-destructive lane seeds rows via the ORM and executes this — a full
# downgrade/upgrade round-trip on app_registry burns pg_attribute slots forever, so it
# stays out of the default lane). The three disjuncts, deliberately:
#   * `approved_submission_id IS NOT NULL` — every row carrying an approved pin, whatever
#     its status today (a re-submitted-then-rejected app keeps its pin, and that pin is a
#     pre-feature approval).
#   * `status IN ('approved', 'disabled')` — the pin-less legacy remainder: a DISABLED
#     row 0018 spared with a NULL pin (the approved-with-no-artifact state) was still
#     approved once, and `disabled` is only reachable FROM approved.
#   * `status = 'pending'` — the then-outstanding queue items (see the module docstring).
# `approval_route IS NULL` keeps this idempotent and blind to rows the publish flow has
# already stamped.
BACKFILL_RUNBOOK_LINEAGE = sa.text(
    "UPDATE app_registry SET approval_route = 'runbook' "
    "WHERE approval_route IS NULL AND ("
    "approved_submission_id IS NOT NULL "
    "OR status IN ('pending', 'approved', 'disabled'))"
)


def upgrade() -> None:
    approval_route.create(op.get_bind(), checkfirst=True)
    op.add_column(
        "app_registry",
        sa.Column("approval_route", approval_route, nullable=True),
    )
    op.add_column(
        "app_registry",
        sa.Column("declaration", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.execute(BACKFILL_RUNBOOK_LINEAGE)


def downgrade() -> None:
    op.drop_column("app_registry", "declaration")
    op.drop_column("app_registry", "approval_route")
    approval_route.drop(op.get_bind(), checkfirst=True)
