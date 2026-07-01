"""The concrete-typing factory contract (ADR-0009), enforced two ways:

1. STATICALLY — `assert_type(...)` calls the three type checkers verify when they
   analyze this file (run in CI). A direct-literal config site resolves to the
   CONCRETE backend; a union/`StorageConfig`-typed site resolves to the base
   `ObjectStorage` (the honest dynamic contract).
2. AT RUNTIME — `isinstance` asserts that the `match` impl dispatches each config
   to the right backend, and that an incomplete `ObjectStorage` subclass is not
   instantiable (ABC enforcement).

Each `assert_type` is placed on the bare call expression BEFORE any `isinstance`
narrowing, so it genuinely tests the overload resolution and not a narrowed type.
"""

from __future__ import annotations

from typing import assert_type

import pytest
from pydantic import SecretStr

from src.services.storage.azure_backend import AzureBlobStorage
from src.services.storage.base import ObjectStorage
from src.services.storage.config import (
    AzureStorageConfig,
    R2StorageConfig,
    S3StorageConfig,
    StorageConfig,
    StorageConfigUnion,
)
from src.services.storage.factory import create_storage, create_storage_for
from src.services.storage.s3_backend import S3ObjectStorage


def _s3_cfg() -> S3StorageConfig:
    return S3StorageConfig(
        bucket="b",
        region="us-east-1",
        access_key_id=SecretStr("ak"),
        secret_access_key=SecretStr("sk"),
    )


def _r2_cfg() -> R2StorageConfig:
    return R2StorageConfig(
        account_id="acct",
        bucket="b",
        access_key_id=SecretStr("ak"),
        secret_access_key=SecretStr("sk"),
    )


def _azure_cfg() -> AzureStorageConfig:
    return AzureStorageConfig(
        account_url="https://a.blob.core.windows.net",
        container="c",
        account_key=SecretStr("key"),
    )


# --- Direct-literal sites resolve to the CONCRETE backend --------------------


def test_s3_config_is_concrete() -> None:
    backend = create_storage(_s3_cfg())
    assert_type(backend, S3ObjectStorage)
    assert isinstance(backend, S3ObjectStorage)


def test_r2_config_is_concrete_s3_backend() -> None:
    backend = create_storage(_r2_cfg())
    assert_type(backend, S3ObjectStorage)  # R2 reuses the S3 backend
    assert isinstance(backend, S3ObjectStorage)
    assert backend.provider == "r2"


def test_azure_config_is_concrete() -> None:
    backend = create_storage(_azure_cfg())
    assert_type(backend, AzureBlobStorage)
    assert isinstance(backend, AzureBlobStorage)


# --- Union / discriminated sites resolve to the BASE type (honest contract) --


def test_union_typed_config_is_base() -> None:
    # A function PARAMETER typed as the union is the genuine un-narrowable site
    # (a `cfg: Union = literal()` local gets narrowed-on-assignment back to the
    # concrete type by ty/pyright — which is correct, just not what we're testing).
    # This mirrors production: `create_storage(settings.object_store)`.
    def via_union(cfg: StorageConfigUnion) -> ObjectStorage:
        backend = create_storage(cfg)
        assert_type(backend, ObjectStorage)  # fallback overload → base
        return backend

    # ...yet runtime dispatch still yields the concrete backend.
    assert isinstance(via_union(_s3_cfg()), S3ObjectStorage)


def test_discriminated_config_field_is_base() -> None:
    # Mirrors `settings.object_store` (typed StorageConfig — the discriminated
    # alias): statically the union, so create_storage returns the base ObjectStorage.
    def via_field(cfg: StorageConfig) -> ObjectStorage:
        backend = create_storage(cfg)
        assert_type(backend, ObjectStorage)
        return backend

    assert isinstance(via_field(_azure_cfg()), AzureBlobStorage)


# --- Literal-string sugar (gated/cuttable; kept only if all 3 checkers pass) -


def test_create_storage_for_literal_is_concrete() -> None:
    s3 = create_storage_for("s3", _s3_cfg())
    assert_type(s3, S3ObjectStorage)
    r2 = create_storage_for("r2", _r2_cfg())
    assert_type(r2, S3ObjectStorage)
    azure = create_storage_for("azure", _azure_cfg())
    assert_type(azure, AzureBlobStorage)
    assert isinstance(s3, S3ObjectStorage)
    assert isinstance(r2, S3ObjectStorage)
    assert isinstance(azure, AzureBlobStorage)


# --- Runtime: exhaustive dispatch + ABC enforcement -------------------------


def test_match_covers_every_config_member() -> None:
    # Collectively proves the factory's `match` dispatches all three members
    # (the 4th-provider case is a compile-time assert_never, not runtime).
    assert isinstance(create_storage(_s3_cfg()), S3ObjectStorage)
    assert isinstance(create_storage(_r2_cfg()), S3ObjectStorage)
    assert isinstance(create_storage(_azure_cfg()), AzureBlobStorage)


def test_incomplete_backend_is_not_instantiable() -> None:
    class Incomplete(ObjectStorage):
        """Implements none of the abstractmethods → must not be instantiable."""

    # The ABC marks every unimplemented method abstract...
    assert "put" in Incomplete.__abstractmethods__
    # ...so instantiation raises TypeError at runtime. The intentional abstract
    # instantiation is suppressed per-checker (the runtime behavior is the point).
    with pytest.raises(TypeError):
        Incomplete(provider="s3")  # type: ignore[abstract]  # pyright: ignore[reportAbstractUsage]
