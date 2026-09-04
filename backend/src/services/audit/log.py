"""Append-only audit helper.

`append_audit` writes ONE accountability row WITHIN the caller's transaction — it flushes but
never commits, so the audit row shares the fate of the gated action and a rolled-back action
leaves no orphan trail. Called wherever a permission-gated or state-changing action succeeds.

A SWEEP'S TRAIL CARRIES COUNTS, NEVER THE NAMES OF WHAT IT FOUND — no object key, per-project
database name, deployment id, sandbox name or app name reaches `detail` or `resource_id`. A
sandbox name embeds its app's uuid, a database name its project's, and a key list is the storage
layout, so a trail holding them stops being an accountability record and becomes a durable
inventory of who has, ran or deployed what. Names go in the operator report; this row gets ints.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from src.db.models.audit import AuditLog


async def append_audit(
    db: AsyncSession,
    *,
    actor_id: uuid.UUID | None,
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    detail: dict[str, Any] | None = None,
) -> AuditLog:
    """Record one accountability event in the CALLER'S transaction. The flush (not
    commit) assigns the id and surfaces a bad FK immediately while keeping the write
    atomic with the gated action — the caller owns the commit."""
    entry = AuditLog(
        actor_id=actor_id,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        detail=detail,
    )
    db.add(entry)
    await db.flush()
    return entry
