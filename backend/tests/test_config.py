"""Config fail-first startup-gate tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from src.config import Settings

# Minimal required fields so Settings validates without reading a real env file.
# model_validate runs full pydantic validation over the dict WITHOUT touching the
# env sources, so it avoids the typed-kwargs path ty/pyright cannot narrow.
_BASE_ENV: dict[str, object] = {
    "ENVIRONMENT": "development",
    "DATABASE_URL": "postgresql+asyncpg://u:p@localhost/test",
}


# A minimal valid object-store block, needed anywhere a production Settings is
# constructed (the prod gate requires storage in production). Azure Blob is the
# only provider.
_AZURE_STORE: dict[str, object] = {
    "provider": "azure",
    "account_url": "https://acct.blob.core.windows.net",
    "container": "b",
    "account_key": "a2V5",
}


def _settings(**overrides: object) -> Settings:
    return Settings.model_validate({**_BASE_ENV, **overrides})


def test_valid_settings_construct() -> None:
    s = _settings()
    assert s.ENVIRONMENT == "development"
    assert s.is_production is False
    # Optional knobs carry their defaults.
    assert s.FRONTEND_URL == "http://localhost:5173"


def test_is_production_true_in_production() -> None:
    # Production requires storage (the prod gate below), so supply it here.
    assert _settings(ENVIRONMENT="production", object_store=_AZURE_STORE).is_production is True


def test_production_requires_object_store() -> None:
    # Prod gate (fail-first-python.md): storage is optional in dev/test but the
    # single sanctioned optional-integration prod gate requires it in production.
    with pytest.raises(ValidationError):
        _settings(ENVIRONMENT="production")


def test_object_store_optional_in_development() -> None:
    # The same missing block is fine in development — it boots without storage.
    assert _settings().object_store is None


def test_environment_is_required() -> None:
    # Fail-first regression guard: ENVIRONMENT has NO default, so an absent env var
    # fails at Settings() construction. (Asserted on the field, not via a partial
    # model_validate, because pydantic-settings still backfills from the dotenv
    # source during validation.)
    assert Settings.model_fields["ENVIRONMENT"].is_required()


def test_database_url_is_required() -> None:
    assert Settings.model_fields["DATABASE_URL"].is_required()


def test_invalid_environment_literal_rejected() -> None:
    # The closed Literal rejects anything outside the three known environments.
    with pytest.raises(ValidationError):
        _settings(ENVIRONMENT="prod")


def test_unknown_key_forbidden() -> None:
    # extra="forbid": a typo'd env key crashes at startup instead of silently
    # falling back to a default.
    with pytest.raises(ValidationError):
        _settings(TOTALLY_BOGUS="x")
