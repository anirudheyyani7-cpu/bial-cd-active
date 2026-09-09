"""`_embed_query_or_none` — the marketplace search box's own fail-open embed call (#191
slice 3)."""

from __future__ import annotations

from pydantic_ai import Embedder
from pydantic_ai.embeddings.result import EmbeddingResult
from pydantic_ai.embeddings.test import TestEmbeddingModel
from structlog.testing import capture_logs

from src.api.v1.marketplace.router import _embed_query_or_none


async def test_returns_none_when_embedder_is_none() -> None:
    assert await _embed_query_or_none(None, "leave tracker") is None


async def test_returns_the_embedding_on_success() -> None:
    embedder = Embedder(TestEmbeddingModel())
    result = await _embed_query_or_none(embedder, "leave tracker")
    assert result is not None
    assert len(result) > 0


async def test_embeds_as_a_query_not_a_document() -> None:
    # R21: the search box embeds with input_type="query" — distinct from the "document"
    # type used for stored descriptions (the write path and the duplicate check).
    captured: dict[str, object] = {}

    class _Recording(TestEmbeddingModel):
        async def embed(self, inputs, *, input_type, settings=None):  # type: ignore[override]
            captured["input_type"] = input_type
            return await super().embed(inputs, input_type=input_type, settings=settings)

    embedder = Embedder(_Recording())
    await _embed_query_or_none(embedder, "leave tracker")
    assert captured["input_type"] == "query"


async def test_a_failed_embed_call_returns_none_rather_than_raising() -> None:
    class _Boom:
        async def embed_query(self, *_a, **_k) -> EmbeddingResult:
            raise RuntimeError("simulated Foundry timeout")

    result = await _embed_query_or_none(_Boom(), "leave tracker")  # type: ignore[arg-type]
    assert result is None


async def test_a_failed_embed_call_is_logged() -> None:
    class _Boom:
        async def embed_query(self, *_a, **_k) -> EmbeddingResult:
            raise RuntimeError("simulated Foundry timeout")

    with capture_logs() as logs:
        await _embed_query_or_none(_Boom(), "leave tracker")  # type: ignore[arg-type]
    assert any(entry["event"] == "marketplace_search_embedding_unavailable" for entry in logs)
