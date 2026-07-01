"""Normalized value types every backend converts SDK responses into, plus the
`ObjectStorage` ABC. No vendor type ever crosses this port — the adapters import
`TypedDict`s / `BlobProperties` / `StreamingBody` only inside their own modules
and return these common types instead.

The ABC + the `@abstractmethod` set are the sanctioned storage-port pattern
(ADR-0009): an ABC, not a Protocol, so nominal subtyping makes an IDE jump land
on the concrete backend and an incomplete backend fails at instantiation.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import datetime, timedelta

from src.services.storage.constants import DEFAULT_PAGE_SIZE, MAX_SIGNED_URL_TTL
from src.services.storage.errors import StorageSignError


@dataclass(frozen=True)
class ObjectMeta:
    """Provider-neutral metadata for one stored object. Only `key` and `size`
    are always present; the rest are nullable because the providers disagree on
    what they return from a `put` vs a `head`."""

    key: str
    size: int
    content_type: str | None
    etag: str | None
    """Quotes stripped; OPAQUE. May carry an S3 multipart `-N` suffix or an Azure
    sequence number. Use only for same-provider change detection — never parse as
    MD5/hex, never treat as a cross-provider identity."""
    last_modified: datetime | None
    """Nullable: absent from `put()` on both providers (a follow-up `head()`
    fills it when a caller needs it)."""


@dataclass(frozen=True)
class ListPage:
    """One page of a prefix listing. `keys` is a tuple so the page is truly
    immutable; `next_token` is a provider-opaque cursor valid only for the same
    store instance (`None` means the listing is exhausted)."""

    keys: tuple[str, ...]
    next_token: str | None


class ObjectStorage(abc.ABC):
    """The lowest-common-denominator async interface — only operations proven
    safe across S3, R2, and Azure Blob. A closed, known 2-impl set (`S3ObjectStorage`
    serves S3+R2; `AzureBlobStorage` is the other), so an ABC (not a Protocol):
    nominal subtyping makes F12 on a concrete factory result land on the concrete
    method, and an incomplete backend fails with a runtime `TypeError`.

    Provider-specific features (tagging, versioning, SSE-KMS, multipart, signed
    UPLOAD URLs, ranged reads) are deliberately NOT here — see the plan's Scope
    Boundaries. Reachable only by downcasting to a concrete backend.
    """

    def __init__(self, *, provider: str) -> None:
        # provider is "s3" | "r2" | "azure" — carried so StorageError correlation
        # is filled without each backend threading it through every raise.
        self._provider = provider

    @property
    def provider(self) -> str:
        return self._provider

    @abc.abstractmethod
    async def put(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> ObjectMeta:
        """Logically-atomic write of `data` (≤ MAX_PUT_BYTES). Returns normalized
        metadata; `etag` is best-effort (MAY be None on Azure) and `last_modified`
        is None — `head()` afterwards for a guaranteed identity."""
        ...

    @abc.abstractmethod
    async def get(self, key: str) -> bytes:
        """Fetch the whole object. Missing object raises StorageNotFoundError."""
        ...

    @abc.abstractmethod
    async def head(self, key: str) -> ObjectMeta | None:
        """Metadata only; folds `exists()`. A missing OBJECT returns None; a
        missing bucket/container raises StorageError."""
        ...

    @abc.abstractmethod
    async def delete(self, key: str) -> None:
        """Idempotent on a missing object (no-op); a missing bucket/container
        raises StorageError."""
        ...

    @abc.abstractmethod
    async def list(
        self, prefix: str, *, page_size: int = DEFAULT_PAGE_SIZE, token: str | None = None
    ) -> ListPage:
        """One page of keys under `prefix`. `next_token` is a provider-opaque
        cursor (None when exhausted)."""
        ...

    async def signed_read_url(self, key: str, *, expires_in: timedelta) -> str:
        """A time-limited read URL (S3/R2 presigned GET, Azure SAS). CONCRETE so
        the ≤ MAX_SIGNED_URL_TTL ceiling is one invariant no backend can skip or
        silently clamp: it is rejected fail-closed here BEFORE any backend runs.

        SECURITY: the returned `str` is a BEARER credential — it embeds
        `X-Amz-Signature` / `sig=`. Callers MUST treat it like a secret and never
        log or persist it in plaintext (the type system can't enforce this on a
        `str`; the contract carries the guarantee).
        """
        if expires_in <= timedelta(0):
            raise StorageSignError("expires_in must be positive", provider=self.provider, key=key)
        if expires_in > MAX_SIGNED_URL_TTL:
            raise StorageSignError(
                f"expires_in exceeds the {MAX_SIGNED_URL_TTL} signed-URL ceiling",
                provider=self.provider,
                key=key,
            )
        return await self._signed_read_url_impl(key, expires_in=expires_in)

    @abc.abstractmethod
    async def _signed_read_url_impl(self, key: str, *, expires_in: timedelta) -> str:
        """Backend hook for `signed_read_url`, called only after the TTL ceiling
        has passed. Backends override THIS, never the public method."""
        ...

    @abc.abstractmethod
    async def aclose(self) -> None:
        """Close the long-lived client(s) (and, on Azure, the credential). Safe to
        call more than once."""
        ...
