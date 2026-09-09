"""Writing a project's description embedding — the never-raises contract (#191 slice 3,
R25/R26)."""

from __future__ import annotations

import uuid

import pytest
from pydantic_ai import Embedder
from pydantic_ai.embeddings.result import EmbeddingResult
from pydantic_ai.embeddings.test import TestEmbeddingModel
from structlog.testing import capture_logs

from src.core.alarms import EMBEDDING_WRITE_FAILED_EVENT
from src.db.models.project import Project
from src.services.embeddings.write import write_description_embedding


def _project(**overrides) -> Project:
    data = {"id": uuid.uuid4(), "user_id": uuid.uuid4(), "name": "Gate Pass Log"}
    data.update(overrides)
    return Project(**data)


async def test_noop_when_embedder_is_none() -> None:
    project = _project(description="a description")
    await write_description_embedding(project, None)
    assert project.description_embedding is None


async def test_noop_when_project_has_no_description() -> None:
    embedder = Embedder(TestEmbeddingModel())
    project = _project(description=None)
    await write_description_embedding(project, embedder)
    assert project.description_embedding is None


async def test_writes_the_embedding_on_success() -> None:
    embedder = Embedder(TestEmbeddingModel())
    project = _project(description="Ground staff log VIP movement requests.")
    await write_description_embedding(project, embedder)
    assert project.description_embedding is not None
    assert len(project.description_embedding) > 0


async def test_embeds_as_a_document_not_a_query() -> None:
    # R21: a stored description is embedded with input_type="document" on both this write
    # path and the duplicate check (slice 4) — never "query", which is reserved for the
    # marketplace's own search box.
    captured: dict[str, object] = {}

    class _Recording(TestEmbeddingModel):
        async def embed(self, inputs, *, input_type, settings=None):  # type: ignore[override]
            captured["input_type"] = input_type
            return await super().embed(inputs, input_type=input_type, settings=settings)

    embedder = Embedder(_Recording())
    project = _project(description="Ground staff log VIP movement requests.")
    await write_description_embedding(project, embedder)
    assert captured["input_type"] == "document"


async def test_a_failed_embed_call_never_raises_and_leaves_the_column_untouched() -> None:
    class _Boom:
        async def embed_documents(self, *_a, **_k) -> EmbeddingResult:
            raise RuntimeError("simulated Foundry timeout")

    project = _project(description="a description")
    project.description_embedding = None
    await write_description_embedding(project, _Boom())  # type: ignore[arg-type]
    assert project.description_embedding is None


async def test_a_failed_embed_call_logs_its_own_distinct_event() -> None:
    class _Boom:
        async def embed_documents(self, *_a, **_k) -> EmbeddingResult:
            raise RuntimeError("simulated Foundry timeout")

    project = _project(description="a description")
    with capture_logs() as logs:
        await write_description_embedding(project, _Boom())  # type: ignore[arg-type]
    failures = [entry for entry in logs if entry["event"] == EMBEDDING_WRITE_FAILED_EVENT]
    assert len(failures) == 1
    assert failures[0]["project_id"] == str(project.id)
    assert failures[0]["reason"] == "RuntimeError"


@pytest.mark.parametrize("existing", [None, [0.1, 0.2, 0.3]])
async def test_a_failed_embed_call_never_clobbers_an_existing_embedding(existing) -> None:
    # A refresh attempt that fails must leave a STALE embedding in place rather than wipe
    # it — a stale-but-present embedding still degrades to "close enough", while wiping it
    # would silently drop the row out of semantic search entirely on a transient failure.
    class _Boom:
        async def embed_documents(self, *_a, **_k) -> EmbeddingResult:
            raise RuntimeError("simulated Foundry timeout")

    project = _project(description="a description")
    project.description_embedding = existing
    await write_description_embedding(project, _Boom())  # type: ignore[arg-type]
    assert project.description_embedding == existing
