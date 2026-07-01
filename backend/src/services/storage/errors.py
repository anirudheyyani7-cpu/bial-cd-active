"""Object-storage error hierarchy. One base carrying the correlation fields
(`provider` + `key`) so logs can pinpoint the failing object without ever needing
the credential.

Security: `provider` and `key` are INTERNAL diagnostic fields for logs only.
`key` encodes the owner-scoped path `att/{user_id}/...` (single-tenant — no
org/project axis, ADR-0004), so the HTTP layer must map any `StorageError` to a
generic user-facing message and never echo `key` into a response body (per
security.md). Every class ends in `Error` (N818).
"""

from __future__ import annotations


class StorageError(Exception):
    """Base for every object-storage failure. Carries the provider and the
    (owner-scoped) key when one is known so logs can correlate. Never carries a
    credential value."""

    def __init__(
        self, message: str, *, provider: str | None = None, key: str | None = None
    ) -> None:
        super().__init__(message)
        self.provider = provider
        self.key = key


class StorageNotFoundError(StorageError):
    """A requested OBJECT is missing — raised by `get()` on a missing key. A
    missing OBJECT folds to `None` on `head` and is a no-op on `delete`; a missing
    container/bucket raises the base `StorageError`, not this class."""


class StorageAuthError(StorageError):
    """The backend rejected the credentials (bad key, expired SAS delegation,
    denied managed identity)."""


class StorageUploadError(StorageError):
    """A `put` failed or was rejected before dispatch (e.g. payload over the
    `MAX_PUT_BYTES` ceiling)."""


class StorageSignError(StorageError):
    """A signed-URL request was rejected — most commonly `expires_in` over the
    `MAX_SIGNED_URL_TTL` ceiling, which the ABC rejects fail-closed before any
    backend runs."""


class UnsupportedCapabilityError(StorageError):
    """A capability outside the lowest-common-denominator interface was invoked
    on a backend that does not support it. Reserved for future provider-specific
    extensions reached via downcast."""
