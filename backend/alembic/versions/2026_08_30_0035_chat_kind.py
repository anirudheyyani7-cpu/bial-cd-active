"""chat_kind — two three-valued concepts collapse into one two-valued one, on both tables

Revision ID: 0035_chat_kind
Revises: 0034_project_description_fts
Create Date: 2026-08-30

`conversation_kind` (planning/assistant/builder) and `conversation_mode` (ask/plan/write)
together decided one thing — what a run may do — and collapse into `chat_kind` (plan/build).
`messages.mode` is RENAMED to `kind`, not reused, so no reader keeps the retired name alive.

WHY THIS EXISTS. Every row becomes `build`: any conversation could switch into building at
any moment, so "was this a Plan chat?" is unanswerable from stored rows, and claiming
otherwise would invent a distinction the data never carried. Two data steps ride with the
DDL so a migrated transcript isn't left holding something new code can't answer: hidden
mode-switch marker rows are deleted, and every outstanding plan-options card is resolved
`refine` so a migrated Build chat never draws a live Build-it button for a tool its new
toolset lacks (the overlay mirrors what `plan_options.record_build_failure` used to write,
before this change retired it).

`downgrade` restores the STRUCTURE, not the distinctions — same one-way-door posture as
0024, because the distinctions were never recoverable from the rows. Hand-finalized; owns
all three enum lifecycles explicitly (`create_type=False`).
"""

from __future__ import annotations

import json
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0035_chat_kind"
down_revision: str | None = "0034_project_description_fts"
branch_labels: str | None = None
depends_on: str | None = None

# Native enums — `create_type=False` so THIS migration owns each lifecycle.
chat_kind = postgresql.ENUM("plan", "build", name="chat_kind", create_type=False)
conversation_kind = postgresql.ENUM(
    "planning", "assistant", "builder", name="conversation_kind", create_type=False
)
conversation_mode = postgresql.ENUM(
    "ask", "plan", "write", name="conversation_mode", create_type=False
)

PLAN_OPTIONS_TOOL = "present_plan_options"
META_PENDING = "plan_options_pending"
META_RESOLVED = "plan_options_resolved"

# The payload serialization contract these overlay rows are written under. They carry an EMPTY
# payload, so the stamp is unobservable either way; it reads 2 because the revision ships with
# the code that writes 2, and a row must never claim an older contract than the one it was
# written under. See `services/messages/store.SCHEMA_VERSION`.
_OVERLAY_SCHEMA_VERSION = 2


def _is_open(resolution: str | None) -> bool:
    """A card is still ACTIONABLE, and so still presses a dead button, when it has no
    resolution. Closing only the newest per conversation isn't enough — an older unresolved
    card projects as `pending` too, drawing its own live offer.

    The `build_failed` arm is belt-and-braces: those cards already read TERMINAL at every
    live reader, so they need no overlay — kept anyway because this revision can't be re-run,
    and the wrong side to err on is the one that leaves a dead button.
    """
    return resolution is None or resolution.startswith("build_failed")


def _resolve_outstanding_plan_options() -> None:
    """Write one `refine` overlay per outstanding card, newest seq onward, per conversation.

    Python, not SQL: resolutions live in two places — row `meta` for overlays, a
    `ToolReturnPart` inside JSONB `payload` for real ones — and walking JSONB in SQL would
    re-encode the wire shape in an unversioned place. The payload LIKE-probe and the
    `pendings`-only scope both bound memory and lock time: this runs in the same transaction
    that holds ACCESS EXCLUSIVE on `messages`, so every row read here extends the outage.
    """
    bind = op.get_bind()
    rows = bind.execute(
        sa.text(
            "SELECT user_id, conversation_id, seq, meta, "
            "  CASE WHEN payload::text LIKE :probe THEN payload END AS payload "
            "FROM messages "
            "WHERE conversation_id IN ("
            "  SELECT conversation_id FROM messages WHERE meta->>'kind' = :pending"
            ") "
            "ORDER BY conversation_id, seq"
        ),
        {"probe": f"%{PLAN_OPTIONS_TOOL}%", "pending": META_PENDING},
    ).mappings()

    pendings: dict[Any, list[str]] = {}
    resolutions: dict[Any, dict[str, str]] = {}
    owners: dict[Any, Any] = {}
    head_seq: dict[Any, int] = {}

    for row in rows:
        conversation_id = row["conversation_id"]
        owners.setdefault(conversation_id, row["user_id"])
        head_seq[conversation_id] = max(head_seq.get(conversation_id, -1), int(row["seq"]))
        meta = row["meta"] if isinstance(row["meta"], dict) else {}
        call_id = meta.get("toolCallId")
        if meta.get("kind") == META_PENDING and isinstance(call_id, str):
            pendings.setdefault(conversation_id, []).append(call_id)
        if meta.get("kind") == META_RESOLVED and isinstance(call_id, str):
            resolutions.setdefault(conversation_id, {})[call_id] = str(
                meta.get("choice", "refine")
            )
        payload = row["payload"]
        if isinstance(payload, str):  # a driver that hands JSONB back as text
            payload = json.loads(payload)
        for message in payload if isinstance(payload, list) else []:
            if not isinstance(message, dict):
                continue
            for part in message.get("parts", []):
                if (
                    isinstance(part, dict)
                    and part.get("part_kind") == "tool-return"
                    and part.get("tool_name") == PLAN_OPTIONS_TOOL
                    and isinstance(part.get("tool_call_id"), str)
                ):
                    resolutions.setdefault(conversation_id, {})[part["tool_call_id"]] = str(
                        part.get("content", "")
                    )

    insert = sa.text(
        "INSERT INTO messages "
        "(user_id, conversation_id, seq, schema_version, entry_kind, visibility, kind, "
        " payload, meta) "
        "VALUES (:user_id, :conversation_id, :seq, :schema_version, 'system_event', 'hidden', "
        " 'build', '[]'::jsonb, CAST(:meta AS jsonb))"
    )
    for conversation_id, call_ids in pendings.items():
        answered = resolutions.get(conversation_id, {})
        next_seq = head_seq[conversation_id] + 1
        for call_id in call_ids:
            if not _is_open(answered.get(call_id)):
                continue
            bind.execute(
                insert,
                {
                    "user_id": owners[conversation_id],
                    "conversation_id": conversation_id,
                    "seq": next_seq,
                    "schema_version": _OVERLAY_SCHEMA_VERSION,
                    "meta": json.dumps(
                        {"kind": META_RESOLVED, "toolCallId": call_id, "choice": "refine"}
                    ),
                },
            )
            next_seq += 1


def upgrade() -> None:
    # The retired markers go first: fewer rows for the type rewrite below to touch, and the
    # `mode_switch` label is inert from this point on.
    op.execute(sa.text("DELETE FROM messages WHERE entry_kind = 'mode_switch'"))

    chat_kind.create(op.get_bind(), checkfirst=True)

    # `conversations`: the kind column swaps type (every row becomes `build`), and the
    # mode column goes entirely. Dropping the column takes its server default with it, which is
    # what lets `conversation_mode` be dropped at the end.
    op.execute(
        sa.text(
            "ALTER TABLE conversations ALTER COLUMN kind TYPE chat_kind USING 'build'::chat_kind"
        )
    )
    op.drop_column("conversations", "mode")

    # `messages`: RENAME then retype, so the data survives and no fresh `pg_attribute` slot is
    # burned (an add-copy-drop would cost two per round-trip test run, permanently, on the
    # shared test database).
    op.execute(sa.text("ALTER TABLE messages RENAME COLUMN mode TO kind"))
    op.execute(
        sa.text("ALTER TABLE messages ALTER COLUMN kind TYPE chat_kind USING 'build'::chat_kind")
    )

    # Only now, with every row stamped, is it safe to retire a card that would otherwise draw a
    # Build-it button for a tool the migrated chat's toolset does not contain.
    _resolve_outstanding_plan_options()

    conversation_kind.drop(op.get_bind(), checkfirst=True)
    conversation_mode.drop(op.get_bind(), checkfirst=True)


def downgrade() -> None:
    conversation_kind.create(op.get_bind(), checkfirst=True)
    conversation_mode.create(op.get_bind(), checkfirst=True)

    op.execute(
        sa.text(
            "ALTER TABLE messages ALTER COLUMN kind TYPE conversation_mode "
            "USING 'write'::conversation_mode"
        )
    )
    op.execute(sa.text("ALTER TABLE messages RENAME COLUMN kind TO mode"))

    op.execute(
        sa.text(
            "ALTER TABLE conversations "
            "ALTER COLUMN kind TYPE conversation_kind USING 'builder'::conversation_kind"
        )
    )
    op.add_column(
        "conversations",
        sa.Column(
            "mode",
            conversation_mode,
            nullable=False,
            server_default=sa.text("'plan'::conversation_mode"),
        ),
    )

    chat_kind.drop(op.get_bind(), checkfirst=True)
