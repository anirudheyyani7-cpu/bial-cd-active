"""AzureBlobStorage — Azure Blob Storage via `azure-storage-blob.aio` +
`azure-identity.aio`. The second of the two backends behind the `ObjectStorage`
interface (the S3 backend serves S3+R2).

No vendor type crosses the port: `BlobProperties`, `ContentSettings`, the page
iterator, and the `upload_blob` `dict[str, Any]` are consumed only here; every
method returns the common `ObjectMeta`/`ListPage`/`bytes`.

Lifecycle: one long-lived `BlobServiceClient` (and, for managed identity, one
credential) per process per config, lazily built into a module-level cache.
`aclose` closes BOTH the client and the credential — an unclosed credential leaks
its own aiohttp session. `close_all_clients()` is the hook `aclose_storage()`
calls on shutdown.
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import NoReturn, cast
from urllib.parse import urlsplit

from azure.core.async_paging import AsyncPageIterator
from azure.core.exceptions import (
    ClientAuthenticationError,
    HttpResponseError,
    ResourceNotFoundError,
    ServiceRequestError,
)
from azure.identity.aio import DefaultAzureCredential
from azure.storage.blob import (
    BlobProperties,
    BlobSasPermissions,
    ContentSettings,
    UserDelegationKey,
    generate_blob_sas,
)
from azure.storage.blob.aio import BlobServiceClient

from src.services.storage.base import ListPage, ObjectMeta, ObjectStorage
from src.services.storage.config import AzureStorageConfig
from src.services.storage.constants import (
    DEFAULT_PAGE_SIZE,
    MAX_PUT_BYTES,
    MAX_SIGNED_URL_TTL,
)
from src.services.storage.errors import (
    StorageAuthError,
    StorageError,
    StorageNotFoundError,
    StorageSignError,
    StorageUploadError,
)
from src.services.storage.keys import normalize_metadata

# Signed URLs / delegation keys start ~15m in the past to tolerate clock skew.
_CLOCK_SKEW = timedelta(minutes=15)


def _now() -> datetime:
    # Indirection so the delegation-key re-mint logic is time-controllable in
    # tests. Repo convention is datetime.now(UTC), not timezone.utc.
    return datetime.now(UTC)


# --- pure helpers (unit-tested directly) -------------------------------------


def _clean_etag(raw: str | None) -> str | None:
    # Strip Azure's quotes; OPAQUE thereafter (a sequence number, never an MD5).
    return (raw or "").strip('"') or None


def _error_code(exc: HttpResponseError) -> str | None:
    # Both ResourceNotFoundError and the broader HttpResponseError carry
    # `error_code`; widened from ResourceNotFoundError so `_raise_azure` can
    # inspect any HttpResponseError (e.g. a 403 → auth).
    code = getattr(exc, "error_code", None)
    return code if isinstance(code, str) else None


def _conn_field(connection_string: str, field: str) -> str | None:
    prefix = f"{field}="
    for part in connection_string.split(";"):
        if part.startswith(prefix):
            return part[len(prefix) :]
    return None


def _account_name(config: AzureStorageConfig) -> str:
    # Connection strings carry AccountName explicitly (and Azurite's path-style
    # URL has no account label in the host); real-Azure account_url is
    # https://{account}.blob.core.windows.net.
    if config.connection_string is not None:
        name = _conn_field(config.connection_string.get_secret_value(), "AccountName")
        if name:
            return name
    host = urlsplit(config.account_url).hostname or ""
    return host.split(".")[0]


def _delegation_expiry(udk: UserDelegationKey) -> datetime:
    # signed_expiry is an ISO-8601 string (often Z-suffixed, which fromisoformat
    # handles on 3.11+, yielding a UTC-aware datetime). It is typed Optional;
    # a None here is an Azure anomaly we fail closed on.
    if udk.signed_expiry is None:
        raise StorageSignError("Azure user-delegation key has no expiry", provider="azure")
    return datetime.fromisoformat(udk.signed_expiry)


def _needs_remint(now: datetime, key_expiry: datetime, expires_in: timedelta) -> bool:
    # Re-mint when the cached delegation key can no longer cover the requested
    # (already ≤ MAX_SIGNED_URL_TTL) duration. A small expires_in reuses a key
    # for most of its 7-day life; only a near-expiry key forces a re-mint.
    return (key_expiry - now) < expires_in


def _sas_expiry(now: datetime, expires_in: timedelta, key_expiry: datetime) -> datetime:
    # Never exceed the delegation key's own lifetime, or Azure rejects the SAS.
    return min(now + expires_in, key_expiry)


def _fingerprint(config: AzureStorageConfig) -> str:
    material: tuple[str, ...]
    if config.connection_string is not None:
        material = ("conn", config.connection_string.get_secret_value())
    elif config.account_key is not None:
        material = ("key", config.account_url, config.account_key.get_secret_value())
    else:
        material = ("mi", config.account_url)
    return sha256("\x00".join(material).encode()).hexdigest()


# --- module-level client cache (source of truth for open SDK clients) ---------


class _AzureClient:
    """Cached per-config state: the long-lived service client, the credential to
    close (managed identity only), and the cached user-delegation key."""

    def __init__(
        self, service_client: BlobServiceClient, *, credential: DefaultAzureCredential | None
    ) -> None:
        self.service_client = service_client
        self.credential = credential
        self.delegation_key: UserDelegationKey | None = None
        self.delegation_expiry: datetime | None = None
        # Serializes delegation-key re-minting so only one coroutine mints.
        self.lock = asyncio.Lock()


_client_cache: dict[str, _AzureClient] = {}


def _build_state(config: AzureStorageConfig) -> _AzureClient:
    # Secrets unwrapped only here, at the SDK boundary (security.md).
    if config.connection_string is not None:
        bsc = BlobServiceClient.from_connection_string(config.connection_string.get_secret_value())
        return _AzureClient(bsc, credential=None)
    if config.account_key is not None:
        bsc = BlobServiceClient(
            config.account_url, credential=config.account_key.get_secret_value()
        )
        return _AzureClient(bsc, credential=None)
    credential = DefaultAzureCredential()
    bsc = BlobServiceClient(config.account_url, credential=credential)
    return _AzureClient(bsc, credential=credential)


async def _close_state(fingerprint: str) -> None:
    state = _client_cache.pop(fingerprint, None)
    if state is not None:
        await state.service_client.close()
        if state.credential is not None:
            # An unclosed credential leaks its own aiohttp session.
            await state.credential.close()


async def close_all_clients() -> None:
    """Close every cached Azure client + credential. Called by `aclose_storage()`
    on shutdown."""
    for fingerprint in list(_client_cache):
        await _close_state(fingerprint)


async def reset_client_for_tests() -> None:
    await close_all_clients()


class AzureBlobStorage(ObjectStorage):
    def __init__(self, config: AzureStorageConfig) -> None:
        super().__init__(provider=config.provider)
        self._config = config
        self._container = config.container
        self._account_url = config.account_url.rstrip("/")
        self._account_name = _account_name(config)
        self._fingerprint = _fingerprint(config)

    @classmethod
    def from_config(cls, config: AzureStorageConfig) -> AzureBlobStorage:
        # No client/credential opened here — the lazy cache opens on first op.
        return cls(config)

    async def _state(self) -> _AzureClient:
        cached = _client_cache.get(self._fingerprint)
        if cached is not None:
            return cached
        state = _build_state(self._config)
        _client_cache[self._fingerprint] = state
        return state

    def _sas_account_key(self) -> str | None:
        # Unwrapped only here, at the SAS-signing boundary.
        if self._config.account_key is not None:
            return self._config.account_key.get_secret_value()
        if self._config.connection_string is not None:
            return _conn_field(self._config.connection_string.get_secret_value(), "AccountKey")
        return None

    def _raise_azure(
        self, exc: HttpResponseError | ServiceRequestError, *, op: str, key: str
    ) -> NoReturn:
        # SANITIZED re-raise (mirrors S3's `_raise`): never the raw exception text,
        # only the operation; provider/key ride on the fields for logs. A 403 (or
        # an explicit auth failure) maps to StorageAuthError, everything else to
        # the base StorageError.
        if isinstance(exc, ClientAuthenticationError) or (
            isinstance(exc, HttpResponseError) and exc.status_code == 403
        ):
            raise StorageAuthError(f"Azure {op} denied", provider=self.provider, key=key) from exc
        raise StorageError(f"Azure {op} failed", provider=self.provider, key=key) from exc

    async def put(
        self,
        key: str,
        data: bytes,
        *,
        content_type: str | None = None,
        metadata: dict[str, str] | None = None,
    ) -> ObjectMeta:
        if len(data) > MAX_PUT_BYTES:
            raise StorageUploadError(
                f"object exceeds the {MAX_PUT_BYTES}-byte put ceiling",
                provider=self.provider,
                key=key,
            )
        state = await self._state()
        blob_client = state.service_client.get_blob_client(self._container, key)
        content_settings = (
            ContentSettings(content_type=content_type) if content_type is not None else None
        )
        try:
            result = await blob_client.upload_blob(
                data,
                overwrite=True,
                content_settings=content_settings,
                metadata=normalize_metadata(metadata),
            )
        except ResourceNotFoundError as exc:
            raise StorageError(
                "Azure container not found", provider=self.provider, key=key
            ) from exc
        except (HttpResponseError, ServiceRequestError) as exc:
            self._raise_azure(exc, op="put", key=key)
        # upload_blob returns dict[str, Any] — narrow the best-effort etag (it MAY
        # be absent; callers needing a guaranteed identity head() afterwards).
        raw_etag = result.get("etag")
        return ObjectMeta(
            key=key,
            size=len(data),
            content_type=content_type,
            etag=_clean_etag(raw_etag if isinstance(raw_etag, str) else None),
            last_modified=None,
        )

    async def get(self, key: str) -> bytes:
        state = await self._state()
        blob_client = state.service_client.get_blob_client(self._container, key)
        try:
            downloader = await blob_client.download_blob()  # never pass encoding=
            data = await downloader.readall()
        except ResourceNotFoundError as exc:
            self._raise_not_found(exc, key=key)
        except (HttpResponseError, ServiceRequestError) as exc:
            self._raise_azure(exc, op="get", key=key)
        # With no encoding, readall() returns bytes; a str would corrupt binary, so
        # fail closed rather than encode() it (readall() is typed str | bytes).
        if not isinstance(data, bytes):
            raise StorageError(
                f"Azure get returned {type(data).__name__}, expected bytes",
                provider=self.provider,
                key=key,
            )
        return data

    async def head(self, key: str) -> ObjectMeta | None:
        state = await self._state()
        blob_client = state.service_client.get_blob_client(self._container, key)
        try:
            props = await blob_client.get_blob_properties()
        except ResourceNotFoundError as exc:
            if _error_code(exc) == "ContainerNotFound":
                raise StorageError(
                    "Azure container not found", provider=self.provider, key=key
                ) from exc
            return None  # missing OBJECT → None
        except (HttpResponseError, ServiceRequestError) as exc:
            self._raise_azure(exc, op="head", key=key)
        # content_settings may be None at runtime even where the stub types it
        # non-optional — narrow before reading content_type.
        cs = props.content_settings
        content_type = cs.content_type if cs is not None else None
        return ObjectMeta(
            key=key,
            size=props.size,
            content_type=content_type,
            etag=_clean_etag(props.etag),
            last_modified=props.last_modified,
        )

    async def delete(self, key: str) -> None:
        state = await self._state()
        blob_client = state.service_client.get_blob_client(self._container, key)
        try:
            await blob_client.delete_blob()
        except ResourceNotFoundError as exc:
            if _error_code(exc) == "ContainerNotFound":
                raise StorageError(
                    "Azure container not found", provider=self.provider, key=key
                ) from exc
            return  # missing BLOB → idempotent no-op (parity with S3)
        except (HttpResponseError, ServiceRequestError) as exc:
            self._raise_azure(exc, op="delete", key=key)

    async def list(
        self, prefix: str, *, page_size: int = DEFAULT_PAGE_SIZE, token: str | None = None
    ) -> ListPage:
        state = await self._state()
        container_client = state.service_client.get_container_client(self._container)
        item_paged = container_client.list_blobs(
            name_starts_with=prefix, results_per_page=page_size
        )
        # by_page() is typed as a bare AsyncIterator; the runtime object is an
        # AsyncPageIterator carrying .continuation_token (cast at this one boundary).
        page_iter = cast(
            "AsyncPageIterator[BlobProperties]", item_paged.by_page(continuation_token=token)
        )
        keys: list[str] = []
        try:
            async for page in page_iter:
                async for blob in page:
                    if blob.name is not None:  # None-filter → provably tuple[str, ...]
                        keys.append(blob.name)
                break  # one page per call
        except ResourceNotFoundError as exc:
            raise StorageError(
                "Azure container not found", provider=self.provider, key=prefix
            ) from exc
        except (HttpResponseError, ServiceRequestError) as exc:
            self._raise_azure(exc, op="list", key=prefix)
        return ListPage(keys=tuple(keys), next_token=page_iter.continuation_token)

    async def _signed_read_url_impl(self, key: str, *, expires_in: timedelta) -> str:
        state = await self._state()
        blob_url = f"{self._account_url}/{self._container}/{key}"
        now = _now()  # computed once, threaded through delegation-key minting
        if self._config.use_managed_identity:
            udk, key_expiry = await self._delegation_key(state, expires_in, now)
            sas = generate_blob_sas(
                account_name=self._account_name,
                container_name=self._container,
                blob_name=key,
                user_delegation_key=udk,
                permission=BlobSasPermissions(read=True),
                expiry=_sas_expiry(now, expires_in, key_expiry),
                start=now - _CLOCK_SKEW,
            )
        else:
            account_key = self._sas_account_key()
            if account_key is None:
                raise StorageSignError(
                    "no account key available for SAS signing",
                    provider=self.provider,
                    key=key,
                )
            sas = generate_blob_sas(
                account_name=self._account_name,
                container_name=self._container,
                blob_name=key,
                account_key=account_key,
                permission=BlobSasPermissions(read=True),
                expiry=now + expires_in,
                start=now - _CLOCK_SKEW,
            )
        return f"{blob_url}?{sas}"

    async def _delegation_key(
        self, state: _AzureClient, expires_in: timedelta, now: datetime
    ) -> tuple[UserDelegationKey, datetime]:
        async with state.lock:
            # Re-check INSIDE the lock so only one coroutine mints; a coroutine that
            # awaited the lock sees the freshly-minted key and reuses it.
            if (
                state.delegation_key is None
                or state.delegation_expiry is None
                or _needs_remint(now, state.delegation_expiry, expires_in)
            ):
                try:
                    # Request the maximum-allowed 7-day window; re-mint proactively
                    # before it can no longer cover a bounded request.
                    key = await state.service_client.get_user_delegation_key(
                        now - _CLOCK_SKEW, now + MAX_SIGNED_URL_TTL
                    )
                except (HttpResponseError, ServiceRequestError) as exc:
                    self._raise_azure(exc, op="sign", key="")
                state.delegation_key = key
                state.delegation_expiry = _delegation_expiry(key)
            return state.delegation_key, state.delegation_expiry

    def _raise_not_found(self, exc: ResourceNotFoundError, *, key: str) -> NoReturn:
        if _error_code(exc) == "ContainerNotFound":
            raise StorageError(
                "Azure container not found", provider=self.provider, key=key
            ) from exc
        raise StorageNotFoundError("object not found", provider=self.provider, key=key) from exc

    async def aclose(self) -> None:
        await _close_state(self._fingerprint)
