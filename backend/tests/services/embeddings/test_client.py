"""Foundry embedding wiring — the Foundry-only guard, the api_key/entra build paths, and the
startup check (#191 slice 3, R19-R23)."""

from __future__ import annotations

import pytest
from openai import Timeout
from pydantic_ai import Embedder
from pydantic_ai.embeddings.openai import OpenAIEmbeddingModel
from structlog.testing import capture_logs

from src.config import FoundryConfig
from src.core.alarms import EMBEDDING_GUARD_VIOLATION_EVENT
from src.services.embeddings.client import (
    EmbeddingFoundryOnlyError,
    _assert_foundry_only,
    assert_embedding_guard_at_startup,
    build_embedder,
)


def _config(**overrides) -> FoundryConfig:
    data = {
        "resource": "myfoundry",
        "deployment": "claude-opus",
        "auth_mode": "api_key",
        "api_key": "k",
        "embedding_deployment": "text-embedding-3-small",
    }
    data.update(overrides)
    return FoundryConfig.model_validate(data)


# --- the guard ------------------------------------------------------------------


def test_guard_rejects_public_openai_api() -> None:
    with pytest.raises(EmbeddingFoundryOnlyError):
        _assert_foundry_only("https://api.openai.com/v1")


def test_guard_rejects_non_foundry_host() -> None:
    with pytest.raises(EmbeddingFoundryOnlyError):
        _assert_foundry_only("https://example.com/openai")


def test_guard_accepts_foundry_host() -> None:
    _assert_foundry_only("https://myfoundry.services.ai.azure.com/openai/")  # no raise


def test_guard_logs_a_distinct_event_before_raising() -> None:
    with capture_logs() as logs:
        with pytest.raises(EmbeddingFoundryOnlyError):
            _assert_foundry_only("https://api.openai.com/v1")
    violations = [entry for entry in logs if entry["event"] == EMBEDDING_GUARD_VIOLATION_EVENT]
    assert len(violations) == 1
    assert violations[0]["endpoint"] == "https://api.openai.com/v1"


# --- build_embedder ---------------------------------------------------------------


def test_build_embedder_returns_none_when_embedding_deployment_unset() -> None:
    # R20's documented optional-knob exception: unset -> semantic search off, not an error.
    config = _config(embedding_deployment=None)
    assert build_embedder(config) is None


def test_build_embedder_from_api_key_config() -> None:
    embedder = build_embedder(_config())
    assert isinstance(embedder, Embedder)


def test_build_embedder_targets_foundry() -> None:
    embedder = build_embedder(_config())
    assert embedder is not None
    model = embedder._get_model()  # noqa: SLF001 — reaching into the resolved model to inspect the client
    assert isinstance(model, OpenAIEmbeddingModel)
    assert ".services.ai.azure.com" in model.base_url
    assert "api.openai.com" not in model.base_url


def test_build_embedder_uses_the_configured_deployment_as_the_model_name() -> None:
    embedder = build_embedder(_config(embedding_deployment="my-custom-embed-deployment"))
    assert embedder is not None
    model = embedder._get_model()  # noqa: SLF001
    assert isinstance(model, OpenAIEmbeddingModel)
    assert model.model_name == "my-custom-embed-deployment"


def test_build_embedder_api_key_mode_requires_a_key() -> None:
    # The config validator already enforces api_key required in api_key mode, so this branch
    # is only reachable if that pairing is bypassed — narrow + fail closed regardless.
    config = _config()
    object.__setattr__(config, "api_key", None)
    with pytest.raises(EmbeddingFoundryOnlyError):
        build_embedder(config)


def test_build_embedder_carries_the_configured_timeout_and_retries() -> None:
    # Review of #191 (agc129): the embedding client had no explicit timeout/retry bound at
    # all, so an unresponsive Foundry endpoint would hang on the OpenAI SDK's own generous
    # default — with the caller's DB transaction still open the whole time, since
    # `write_description_embedding` runs before `db.commit()`. Pinned here against the SAME
    # `FoundryConfig` fields the Claude path already shares (`read_timeout_s`/
    # `connect_timeout_s`/`max_retries`), reached via the model's private client because
    # neither `Embedder` nor `OpenAIEmbeddingModel` surfaces them publicly.
    config = _config(read_timeout_s=42.0, connect_timeout_s=7.0, max_retries=3)
    embedder = build_embedder(config)
    assert embedder is not None
    model = embedder._get_model()  # noqa: SLF001
    assert isinstance(model, OpenAIEmbeddingModel)
    client = model._client  # noqa: SLF001 — the underlying AsyncAzureOpenAI
    assert isinstance(client.timeout, Timeout)
    assert client.timeout.read == 42.0
    assert client.timeout.connect == 7.0
    assert client.max_retries == 3


def test_build_embedder_entra_mode_also_targets_foundry(monkeypatch: pytest.MonkeyPatch) -> None:
    # The PRODUCTION path is managed-identity (entra), not api_key — stub the Azure credential +
    # token provider (never invoked at construction) so this exercises the real else-branch.
    import azure.identity

    monkeypatch.setattr(azure.identity, "DefaultAzureCredential", lambda *a, **k: object())
    monkeypatch.setattr(azure.identity, "get_bearer_token_provider", lambda *a, **k: lambda: "t")
    embedder = build_embedder(_config(auth_mode="entra", api_key=None))
    assert embedder is not None
    model = embedder._get_model()  # noqa: SLF001
    assert isinstance(model, OpenAIEmbeddingModel)
    assert ".services.ai.azure.com" in model.base_url


# --- the startup check (R23) -------------------------------------------------------


def test_startup_check_is_a_noop_when_foundry_is_unconfigured() -> None:
    assert_embedding_guard_at_startup(None)  # no raise


def test_startup_check_is_a_noop_when_embedding_deployment_is_unset() -> None:
    config = _config(embedding_deployment=None)
    assert_embedding_guard_at_startup(config)  # no raise — dev/test boot without it


def test_startup_check_passes_for_a_correctly_wired_resource() -> None:
    assert_embedding_guard_at_startup(_config())  # no raise


def test_startup_check_fails_the_deploy_on_a_bad_wire(monkeypatch: pytest.MonkeyPatch) -> None:
    # Simulate a mis-wired resource: patch the guard itself to see the startup path actually
    # propagates it (never catches and continues — that would be the exact silent degrade R23
    # exists to prevent).
    def _boom(base_url: str) -> None:
        raise EmbeddingFoundryOnlyError("bad wire")

    monkeypatch.setattr("src.services.embeddings.client._assert_foundry_only", _boom)
    with pytest.raises(EmbeddingFoundryOnlyError):
        assert_embedding_guard_at_startup(_config())
