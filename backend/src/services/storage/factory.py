"""The concrete-typing factory (ADR-0009). `create_storage(s3_cfg)` resolves to
the *concrete* `S3ObjectStorage` in the IDE (working F12 + hover) under all three
type checkers, while a union/dynamic-typed config honestly resolves to the base
`ObjectStorage`.

Pattern borrowed from typeshed's `open()` / `boto3-stubs`: `@overload` keyed on
the config TYPE, the broad fallback overload listed LAST (ordering is
load-bearing), and a single undecorated `match`-narrowing implementation.
"""

from __future__ import annotations

from typing import Literal, assert_never, overload

from src.services.storage.azure_backend import AzureBlobStorage
from src.services.storage.base import ObjectStorage
from src.services.storage.config import (
    AzureStorageConfig,
    R2StorageConfig,
    S3StorageConfig,
    StorageConfigUnion,
)
from src.services.storage.s3_backend import S3ObjectStorage


@overload
def create_storage(config: S3StorageConfig) -> S3ObjectStorage: ...
@overload
def create_storage(config: R2StorageConfig) -> S3ObjectStorage: ...  # R2 reuses the S3 backend
@overload
def create_storage(config: AzureStorageConfig) -> AzureBlobStorage: ...
@overload
def create_storage(config: StorageConfigUnion) -> ObjectStorage: ...  # fallback — MUST be last
def create_storage(config: StorageConfigUnion) -> ObjectStorage:
    """Resolve a provider-specific config to its backend.

    A concrete config literal in -> the CONCRETE backend out (F12/hover land on
    the class). A union/validated-config in -> the base `ObjectStorage` (the
    honest dynamic contract: e.g. `settings.object_store` is statically the union,
    so `get_storage()` returns the base type).

    The fallback overload does NOT overlap the concrete ones: each config model
    carries a distinct REQUIRED `Literal` discriminator (`provider`), so the
    models are not structurally assignable to one another and the type checkers
    keep the concrete overloads ahead of the fallback. Keep those discriminators
    required and distinct — making any config all-optional would collapse the
    overload set into an `overload-overlap` error.
    """
    match config:
        case S3StorageConfig() | R2StorageConfig():
            return S3ObjectStorage.from_config(config)
        case AzureStorageConfig():
            return AzureBlobStorage.from_config(config)
        case _:
            # Exhaustive over StorageConfigUnion: a future 4th provider becomes a
            # compile-time failure here, not a silent `None`.
            assert_never(config)


@overload
def create_storage_for(provider: Literal["s3"], config: S3StorageConfig) -> S3ObjectStorage: ...
@overload
def create_storage_for(provider: Literal["r2"], config: R2StorageConfig) -> S3ObjectStorage: ...
@overload
def create_storage_for(
    provider: Literal["azure"], config: AzureStorageConfig
) -> AzureBlobStorage: ...
@overload
def create_storage_for(provider: str, config: StorageConfigUnion) -> ObjectStorage: ...
def create_storage_for(provider: str, config: StorageConfigUnion) -> ObjectStorage:
    """Literal-string sugar over `create_storage`. A separate, cuttable add-on —
    its own name so the `str` fallback can never shadow `create_storage`. The
    `provider` arg only drives the typing; dispatch is by config type. Kept only
    because it verifies green on all three checkers (see test_factory)."""
    if config.provider != provider:
        raise ValueError(
            f"create_storage_for: provider {provider!r} does not match "
            f"config.provider {config.provider!r}"
        )
    return create_storage(config)
