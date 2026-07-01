"""S3ObjectStorage — serves AWS S3 AND Cloudflare R2 (R2 is S3-compatible) via
`aiobotocore`. Two backends behind one interface, not three: R2 is the same
adapter with an `endpoint_url`, `region="auto"`, path addressing, and the
checksum-disable flags branched inside the client builder.

No vendor type crosses the port: the `types-aiobotocore` `TypedDict`s and the
`StreamingBody` are imported and consumed only here; every method returns the
common `ObjectMeta`/`ListPage`/`bytes`.

Client lifecycle: one long-lived client per process per config, lazily built into
a module-level cache keyed by a config fingerprint, with `reset_client_for_tests`.
`close_all_clients()` is the hook `aclose_storage()` calls on shutdown.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from datetime import timedelta
from hashlib import sha256
from importlib.metadata import version
from typing import TYPE_CHECKING, Final, NoReturn

from aiobotocore.config import AioConfig
from botocore.exceptions import BotoCoreError, ClientError

from src.services.storage.base import ListPage, ObjectMeta, ObjectStorage
from src.services.storage.config import R2StorageConfig, S3StorageConfig
from src.services.storage.constants import DEFAULT_PAGE_SIZE, MAX_PUT_BYTES
from src.services.storage.errors import (
    StorageAuthError,
    StorageError,
    StorageNotFoundError,
    StorageSignError,
    StorageUploadError,
)
from src.services.storage.keys import normalize_metadata

if TYPE_CHECKING:
    # Dev-only type stubs (types-aiobotocore[s3], in the `dev` dependency group):
    # imported for annotations ONLY. `from __future__ import annotations` makes all
    # annotations lazy strings, so these names are never evaluated at runtime — the
    # prod image (built with --no-group dev) imports this module without them.
    from types_aiobotocore_s3 import S3Client
    from types_aiobotocore_s3.type_defs import (
        ListObjectsV2RequestTypeDef,
        PutObjectRequestTypeDef,
    )

# S3 error codes that mean "your credentials/signature were rejected" rather than
# "the object/bucket is wrong" — mapped to StorageAuthError.
_AUTH_ERROR_CODES: Final = frozenset(
    {"AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "ExpiredToken", "InvalidToken"}
)

_S3Config = S3StorageConfig | R2StorageConfig


# --- client config derivation (pure; unit-tested by config introspection) ----


def _r2_endpoint(config: R2StorageConfig) -> str:
    # `default` jurisdiction has NO infix (never interpolate `.default.`); `eu` /
    # `fedramp` insert the jurisdiction as a subdomain segment.
    if config.jurisdiction == "default":
        return f"https://{config.account_id}.r2.cloudflarestorage.com"
    return f"https://{config.account_id}.{config.jurisdiction}.r2.cloudflarestorage.com"


def _endpoint_for(config: _S3Config) -> str | None:
    if isinstance(config, R2StorageConfig):
        return _r2_endpoint(config)
    return config.endpoint_url  # None = real AWS endpoint


def _region_for(config: _S3Config) -> str:
    return "auto" if isinstance(config, R2StorageConfig) else config.region


def _checksum_config_supported() -> bool:
    parts = version("botocore").split(".")
    return (int(parts[0]), int(parts[1])) >= (1, 36)


def _boto_config_for(config: _S3Config) -> AioConfig:
    if isinstance(config, R2StorageConfig):
        # botocore>=1.36 defaults checksum calculation to WHEN_SUPPORTED, which
        # breaks R2 PutObject/UploadPart. Force `when_required`. aiobotocore pins
        # botocore well past 1.36, so the guard below is unreachable documentation
        # (not a live two-way fork) — it turns a would-be cryptic Config TypeError
        # on an impossibly-old botocore into a clear error.
        if not _checksum_config_supported():  # pragma: no cover
            raise StorageError(
                "botocore < 1.36 cannot disable checksum calculation, which Cloudflare "
                "R2 requires; upgrade botocore",
                provider="r2",
            )
        return AioConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
        )
    # Real AWS S3 uses virtual-hosted addressing; an S3-compatible endpoint
    # (endpoint_url set — MinIO, Wasabi, …) needs path addressing, since
    # `bucket.localhost` virtual hosts don't resolve. AWS's default checksum
    # behavior (WHEN_SUPPORTED) is correct on real S3.
    addressing = "path" if config.endpoint_url else "virtual"
    return AioConfig(signature_version="s3v4", s3={"addressing_style": addressing})


def _fingerprint(config: _S3Config) -> str:
    # Hash the client-determining fields (NOT the bucket — the client is per
    # endpoint+credentials, the bucket is a per-op param). Secrets go into the
    # hash input transiently; only the digest is held as the cache key.
    material: tuple[str, ...]
    if isinstance(config, R2StorageConfig):
        material = (
            "r2",
            config.account_id,
            config.jurisdiction,
            config.access_key_id.get_secret_value(),
            config.secret_access_key.get_secret_value(),
        )
    else:
        material = (
            "s3",
            config.region,
            config.endpoint_url or "",
            config.access_key_id.get_secret_value(),
            config.secret_access_key.get_secret_value(),
        )
    return sha256("\x00".join(material).encode()).hexdigest()


# --- module-level client cache (the source of truth for open SDK clients) -----

_client_cache: dict[str, tuple[AsyncExitStack, S3Client]] = {}
# Per-fingerprint cold-start locks. Steady state stays lock-free (the cache hit
# below never touches a lock); only the cold-miss path serializes builders for a
# given config so concurrent cold-starts can't build duplicate clients and leak
# the loser's AsyncExitStack.
_client_locks: dict[str, asyncio.Lock] = {}


async def _shared_client(config: _S3Config, fingerprint: str) -> S3Client:
    """Lazily build (or reuse) the long-lived client for this config. NOT
    lock-free: the builder awaits, so a cold miss takes a per-config lock and
    double-checks the cache to avoid duplicate clients. Steady state (the cache
    hit) remains lock-free — one client per config."""
    cached = _client_cache.get(fingerprint)
    if cached is not None:
        return cached[1]
    lock = _client_locks.setdefault(fingerprint, asyncio.Lock())
    async with lock:
        # Double-checked: another coroutine may have built it while we awaited
        # the lock — if so, reuse it and DO NOT build (no leaked ExitStack).
        cached = _client_cache.get(fingerprint)
        if cached is not None:
            return cached[1]
        # Lazy import: aiobotocore opens an aiohttp session, so we keep the import
        # off module load.
        from aiobotocore.session import get_session

        session = get_session()
        stack = AsyncExitStack()
        # Secrets unwrapped only here, at the SDK boundary (security.md).
        client = await stack.enter_async_context(
            session.create_client(
                "s3",
                region_name=_region_for(config),
                endpoint_url=_endpoint_for(config),
                aws_access_key_id=config.access_key_id.get_secret_value(),
                aws_secret_access_key=config.secret_access_key.get_secret_value(),
                config=_boto_config_for(config),
            )
        )
        _client_cache[fingerprint] = (stack, client)
        return client


async def _close_client(fingerprint: str) -> None:
    cached = _client_cache.pop(fingerprint, None)
    if cached is not None:
        await cached[0].aclose()


async def close_all_clients() -> None:
    """Close every cached S3/R2 client (and its aiohttp session). Called by
    `aclose_storage()` on shutdown."""
    # list() is REQUIRED, not redundant: _close_client() pops from _client_cache,
    # so iterating the live dict would raise "dictionary changed size during
    # iteration". Snapshot the keys first.
    for fingerprint in list(_client_cache):
        await _close_client(fingerprint)


async def reset_client_for_tests() -> None:
    await close_all_clients()


# --- response normalization (pure) -------------------------------------------


def _clean_etag(raw: str | None) -> str | None:
    # Strip S3's surrounding quotes; OPAQUE thereafter (never parsed as MD5).
    return (raw or "").strip('"') or None


def _error_code(exc: ClientError) -> str:
    error = exc.response.get("Error")
    if isinstance(error, dict):
        code = error.get("Code")
        if isinstance(code, str):
            return code
    return ""


def _http_status(exc: ClientError) -> int | None:
    meta = exc.response.get("ResponseMetadata")
    if isinstance(meta, dict):
        status = meta.get("HTTPStatusCode")
        if isinstance(status, int):
            return status
    return None


class S3ObjectStorage(ObjectStorage):
    def __init__(self, config: _S3Config) -> None:
        super().__init__(provider=config.provider)
        self._config = config
        self._bucket = config.bucket
        self._fingerprint = _fingerprint(config)

    @classmethod
    def from_config(cls, config: _S3Config) -> S3ObjectStorage:
        # No client opened here — the lazy config-keyed singleton opens on first op.
        return cls(config)

    async def _client(self) -> S3Client:
        return await _shared_client(self._config, self._fingerprint)

    def _raise(
        self, exc: ClientError, *, op: str, key: str, cls: type[StorageError] = StorageError
    ) -> NoReturn:
        # Re-raise as a SANITIZED StorageError: message carries only the operation
        # and the (fixed-vocabulary, credential-free) S3 error code; never the raw
        # ClientError text. provider/key ride on the exception fields for logs.
        code = _error_code(exc)
        if code in _AUTH_ERROR_CODES:
            raise StorageAuthError(f"S3 {op} denied", provider=self.provider, key=key) from exc
        raise cls(f"S3 {op} failed ({code})", provider=self.provider, key=key) from exc

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
        client = await self._client()
        params: PutObjectRequestTypeDef = {"Bucket": self._bucket, "Key": key, "Body": data}
        if content_type is not None:
            params["ContentType"] = content_type
        normalized = normalize_metadata(metadata)
        if normalized is not None:
            params["Metadata"] = normalized
        try:
            resp = await client.put_object(**params)
        except ClientError as exc:
            self._raise(exc, op="put", key=key, cls=StorageUploadError)
        except BotoCoreError as exc:
            raise StorageError("S3 put failed", provider=self.provider, key=key) from exc
        return ObjectMeta(
            key=key,
            size=len(data),
            content_type=content_type,
            etag=_clean_etag(resp.get("ETag")),
            last_modified=None,  # absent from put on both providers
        )

    async def get(self, key: str) -> bytes:
        client = await self._client()
        try:
            resp = await client.get_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            # A missing BUCKET is a StorageError, not a missing-OBJECT 404: only a
            # NoSuchKey (or a 404 that is NOT NoSuchBucket) folds to NotFound.
            code = _error_code(exc)
            if code != "NoSuchBucket" and (code == "NoSuchKey" or _http_status(exc) == 404):
                raise StorageNotFoundError(
                    "object not found", provider=self.provider, key=key
                ) from exc
            self._raise(exc, op="get", key=key)
        except BotoCoreError as exc:
            raise StorageError("S3 get failed", provider=self.provider, key=key) from exc
        # resp["Body"] is the ASYNC StreamingBody — read it inside its context.
        async with resp["Body"] as body:
            return await body.read()

    async def head(self, key: str) -> ObjectMeta | None:
        client = await self._client()
        try:
            resp = await client.head_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            if _http_status(exc) == 404:
                # S3 HEAD has an EMPTY body, so a missing bucket may surface as a
                # bare 404 with no code — best-effort detection of the bucket case.
                if _error_code(exc) == "NoSuchBucket":
                    self._raise(exc, op="head", key=key)
                return None  # missing OBJECT → None
            self._raise(exc, op="head", key=key)
        except BotoCoreError as exc:
            raise StorageError("S3 head failed", provider=self.provider, key=key) from exc
        content_length = resp.get("ContentLength")
        if content_length is None:
            # A missing ContentLength on an EXISTING object is an anomaly — raise
            # rather than silently report 0 (a real 0-byte object returns 0).
            raise StorageError(
                "S3 head returned no ContentLength for an existing object",
                provider=self.provider,
                key=key,
            )
        return ObjectMeta(
            key=key,
            size=content_length,
            content_type=resp.get("ContentType"),
            etag=_clean_etag(resp.get("ETag")),
            last_modified=resp.get("LastModified"),
        )

    async def delete(self, key: str) -> None:
        client = await self._client()
        try:
            # delete_object on a missing KEY is a no-op (S3 returns 204); an error
            # here means missing bucket / denied — surface it.
            await client.delete_object(Bucket=self._bucket, Key=key)
        except ClientError as exc:
            self._raise(exc, op="delete", key=key)
        except BotoCoreError as exc:
            raise StorageError("S3 delete failed", provider=self.provider, key=key) from exc

    async def list(
        self, prefix: str, *, page_size: int = DEFAULT_PAGE_SIZE, token: str | None = None
    ) -> ListPage:
        client = await self._client()
        # Only the R2-supported param subset (Bucket/Prefix/MaxKeys/Continuation).
        params: ListObjectsV2RequestTypeDef = {
            "Bucket": self._bucket,
            "Prefix": prefix,
            "MaxKeys": page_size,
        }
        if token is not None:
            params["ContinuationToken"] = token
        try:
            resp = await client.list_objects_v2(**params)
        except ClientError as exc:
            self._raise(exc, op="list", key=prefix)
        except BotoCoreError as exc:
            raise StorageError("S3 list failed", provider=self.provider, key=prefix) from exc
        contents = resp.get("Contents")
        if contents is None:  # absent on 0 results
            return ListPage(keys=(), next_token=None)
        # None-filter so keys is provably tuple[str, ...] (Key types as str | None).
        keys = tuple(k for k in (obj.get("Key") for obj in contents) if k is not None)
        return ListPage(keys=keys, next_token=resp.get("NextContinuationToken"))

    async def _signed_read_url_impl(self, key: str, *, expires_in: timedelta) -> str:
        client = await self._client()
        # On aiobotocore 3.7 generate_presigned_url is a COROUTINE (verified
        # against the installed stub + runtime) — await it. Signed against the
        # configured S3/R2 endpoint only, never a custom domain.
        try:
            return await client.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket, "Key": key},
                ExpiresIn=int(expires_in.total_seconds()),
            )
        except ClientError as exc:
            self._raise(exc, op="sign", key=key, cls=StorageSignError)
        except BotoCoreError as exc:
            raise StorageError("S3 sign failed", provider=self.provider, key=key) from exc

    async def aclose(self) -> None:
        await _close_client(self._fingerprint)
