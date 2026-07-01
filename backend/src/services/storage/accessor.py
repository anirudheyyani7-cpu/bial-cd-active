"""App-level storage accessor + lifecycle. Two caching layers, kept distinct:

1. *Backend level* (the source of truth for open SDK clients) — each backend's
   config-fingerprint client cache (`s3_backend`/`azure_backend`).
2. *App level* — `get_storage()` reads `settings.object_store`, calls
   `create_storage` ONCE, and memoises the returned backend. It opens no clients
   of its own; it just holds a reference into layer 1.

`get_storage()` returns the base `ObjectStorage` because `settings.object_store`
is statically the union — the honest dynamic contract (concrete types are for code
holding a named config). It lazy-imports `settings` so this module can be
re-exported from the package `__init__` without an import cycle through
`src.config` (which itself imports `storage.config`).
"""

from __future__ import annotations

from src.services.storage import azure_backend, s3_backend
from src.services.storage.base import ObjectStorage
from src.services.storage.errors import StorageError
from src.services.storage.factory import create_storage

_backend_singleton: ObjectStorage | None = None


def get_storage() -> ObjectStorage:
    """The configured backend (layer-2 singleton). Raises if storage is unset
    (genuinely-optional in dev/test; the prod gate in `src.config` requires it)."""
    global _backend_singleton
    if _backend_singleton is None:
        from src.config import settings  # lazy: avoid an import cycle via src.config

        if settings.object_store is None:
            raise StorageError(
                "storage is not configured: set OBJECT_STORE__PROVIDER and the provider's "
                "OBJECT_STORE__* credentials, or call get_storage() only where storage is set"
            )
        _backend_singleton = create_storage(settings.object_store)
    return _backend_singleton


async def aclose_storage() -> None:
    """Close every cached backend client (layer 1, across both backends — and the
    Azure credential) and drop the layer-2 singleton. Wired into the FastAPI
    lifespan shutdown."""
    global _backend_singleton
    await s3_backend.close_all_clients()
    await azure_backend.close_all_clients()
    _backend_singleton = None


async def reset_storage_for_tests() -> None:
    """Reset BOTH layers so a suite that builds backends with different configs
    never reuses a stale client across tests."""
    global _backend_singleton
    _backend_singleton = None
    await s3_backend.reset_client_for_tests()
    await azure_backend.reset_client_for_tests()
