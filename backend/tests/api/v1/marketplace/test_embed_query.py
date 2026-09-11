"""`_embed_query_or_none` — the marketplace search box's own fail-open embed call (#191
slice 3)."""

from __future__ import annotations

from pydantic_ai import Embedder
from pydantic_ai.embeddings.test import TestEmbeddingModel
from structlog.testing import capture_logs

from src.api.v1.marketplace.router import _embed_query_or_none


class _BoomModel(TestEmbeddingModel):
    """A REAL `EmbeddingModel` that always raises, wrapped in a real `Embedder` at each call
    site — not a duck-typed stand-in for `Embedder` itself. `Embedder` is a concrete class,
    so a bare object exposing only `embed_query` satisfies mypy's structural leniency but not
    `ty`'s nominal check against `Embedder | None`; the four-gate policy needs every fake to
    be the real thing underneath, same shape as `_Recording` below."""

    async def embed(self, inputs, *, input_type, settings=None):
        raise RuntimeError("simulated Foundry timeout")


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
        async def embed(self, inputs, *, input_type, settings=None):
            captured["input_type"] = input_type
            return await super().embed(inputs, input_type=input_type, settings=settings)

    embedder = Embedder(_Recording())
    await _embed_query_or_none(embedder, "leave tracker")
    assert captured["input_type"] == "query"


async def test_a_failed_embed_call_returns_none_rather_than_raising() -> None:
    embedder = Embedder(_BoomModel())
    result = await _embed_query_or_none(embedder, "leave tracker")
    assert result is None


async def test_a_failed_embed_call_is_logged() -> None:
    embedder = Embedder(_BoomModel())
    with capture_logs() as logs:
        await _embed_query_or_none(embedder, "leave tracker")
    assert any(entry["event"] == "marketplace_search_embedding_unavailable" for entry in logs)
