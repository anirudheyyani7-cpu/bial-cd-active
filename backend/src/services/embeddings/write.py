"""Writing a project's description embedding (#191 slice 3, R25/R26)."""

from __future__ import annotations

import structlog
from pydantic_ai import Embedder

from src.core.alarms import EMBEDDING_WRITE_FAILED_EVENT
from src.db.models.project import Project

logger = structlog.get_logger()


async def write_description_embedding(project: Project, embedder: Embedder | None) -> None:
    """Embed `project.description` and set `project.description_embedding` on the ORM
    object (the caller commits) — or leave the column untouched on any failure.

    NEVER RAISES (R26): an embedding failure must never fail the project write itself. A
    row left with no embedding (or a stale one, if this was meant to refresh an existing
    value) simply falls back to keyword-only search — the hybrid query already treats an
    absent embedding as a normal case for every pre-#191 project, not a special one.

    A no-op when embeddings aren't configured (`embedder is None`, R20's optional-knob
    exception) or the project has no description at all (nothing to embed — R14 grandfather
    projects). The CALLER decides WHEN to call this: on every create (description is always
    set as of #191) and on a patch only when `description` actually changed (R25 — "written
    when first set and refreshed whenever it changes", not on every unrelated edit).
    """
    if embedder is None or project.description is None:
        return
    try:
        result = await embedder.embed_documents(project.description)
        project.description_embedding = list(result.embeddings[0])
    except Exception as exc:  # noqa: BLE001 — degraded state, never a failed write (R26)
        logger.warning(
            EMBEDDING_WRITE_FAILED_EVENT,
            project_id=str(project.id),
            reason=type(exc).__name__,
        )
