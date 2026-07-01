"""S3/R2 backend unit tests — network-free. We introspect the constructed
botocore config + the pure derivation helpers (endpoint, region, sigv4, checksum
flags, addressing) and exercise the pre-flight guards (put-size ceiling, signed-URL
TTL) that reject BEFORE any client is opened. Round-trips against MinIO live in
the opt-in integration suite (`-m integration`), since `moto` cannot intercept
aiobotocore.
"""

from __future__ import annotations

from datetime import timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError
from pydantic import SecretStr

from src.services.storage import s3_backend
from src.services.storage.config import R2StorageConfig, S3StorageConfig
from src.services.storage.errors import StorageSignError, StorageUploadError
from src.services.storage.s3_backend import (
    S3ObjectStorage,
    _clean_etag,
    _endpoint_for,
    _error_code,
    _fingerprint,
    _http_status,
    _region_for,
)


def _s3(**overrides: object) -> S3StorageConfig:
    base: dict[str, object] = {
        "bucket": "b",
        "region": "us-east-1",
        "access_key_id": SecretStr("ak"),
        "secret_access_key": SecretStr("sk"),
    }
    return S3StorageConfig.model_validate({**base, **overrides})


def _r2(**overrides: object) -> R2StorageConfig:
    base: dict[str, object] = {
        "account_id": "acct",
        "bucket": "b",
        "access_key_id": SecretStr("ak"),
        "secret_access_key": SecretStr("sk"),
    }
    return R2StorageConfig.model_validate({**base, **overrides})


# --- endpoint / region derivation -------------------------------------------


def test_s3_endpoint_default_is_none() -> None:
    assert _endpoint_for(_s3()) is None  # real AWS endpoint


def test_s3_endpoint_custom_passthrough() -> None:
    assert (
        _endpoint_for(_s3(endpoint_url="https://minio.local:9000")) == "https://minio.local:9000"
    )


def test_r2_endpoint_default_has_no_infix() -> None:
    url = _endpoint_for(_r2(jurisdiction="default"))
    assert url == "https://acct.r2.cloudflarestorage.com"
    assert ".default." not in (url or "")


@pytest.mark.parametrize(
    ("jurisdiction", "expected"),
    [
        ("eu", "https://acct.eu.r2.cloudflarestorage.com"),
        ("fedramp", "https://acct.fedramp.r2.cloudflarestorage.com"),
    ],
)
def test_r2_endpoint_jurisdiction(jurisdiction: str, expected: str) -> None:
    assert _endpoint_for(_r2(jurisdiction=jurisdiction)) == expected


def test_region_for() -> None:
    assert _region_for(_s3(region="eu-west-1")) == "eu-west-1"
    assert _region_for(_r2()) == "auto"  # R2 always 'auto'


# --- botocore Config introspection ------------------------------------------


# botocore builds Config attributes dynamically (OPTION_DEFAULTS), so the stub
# declares none of them — introspect through an `Any` local.
def test_s3_config_is_sigv4_virtual_no_checksum_flags() -> None:
    cfg: Any = s3_backend._boto_config_for(_s3())
    assert cfg.signature_version == "s3v4"
    assert cfg.s3 == {"addressing_style": "virtual"}


def test_s3_custom_endpoint_uses_path_addressing() -> None:
    # An S3-compatible endpoint (MinIO etc.) needs path addressing — virtual
    # hosts like bucket.localhost don't resolve.
    cfg: Any = s3_backend._boto_config_for(_s3(endpoint_url="http://localhost:9000"))
    assert cfg.s3 == {"addressing_style": "path"}


def test_r2_config_forces_sigv4_path_and_checksum_flags() -> None:
    cfg: Any = s3_backend._boto_config_for(_r2())
    assert cfg.signature_version == "s3v4"
    assert cfg.s3 == {"addressing_style": "path"}
    # The R2 landmine: these MUST be present (always-on under modern botocore).
    assert cfg.request_checksum_calculation == "when_required"
    assert cfg.response_checksum_validation == "when_required"


# --- fingerprint (client cache key) -----------------------------------------


def test_fingerprint_stable_for_same_config() -> None:
    assert _fingerprint(_s3()) == _fingerprint(_s3())


def test_fingerprint_ignores_bucket() -> None:
    # The client is per endpoint+credentials, not per bucket — same fingerprint.
    assert _fingerprint(_s3(bucket="one")) == _fingerprint(_s3(bucket="two"))


def test_fingerprint_differs_on_region() -> None:
    assert _fingerprint(_s3(region="us-east-1")) != _fingerprint(_s3(region="eu-west-1"))


def test_fingerprint_differs_on_provider() -> None:
    assert _fingerprint(_s3()) != _fingerprint(_r2())


# --- response normalization helpers -----------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ('"abc123"', "abc123"),
        ('"abc-2"', "abc-2"),  # multipart suffix preserved (opaque)
        ("", None),
        (None, None),
    ],
)
def test_clean_etag(raw: str | None, expected: str | None) -> None:
    assert _clean_etag(raw) == expected


def test_error_code_and_http_status_extraction() -> None:
    # `Any` sidesteps botocore-stubs' strict ResponseMetadata TypedDict (which
    # would require HTTPHeaders/HostId/RequestId/RetryAttempts) for a fixture.
    response: Any = {
        "Error": {"Code": "NoSuchBucket"},
        "ResponseMetadata": {"HTTPStatusCode": 404},
    }
    exc = ClientError(response, "HeadObject")
    assert _error_code(exc) == "NoSuchBucket"
    assert _http_status(exc) == 404


def test_error_code_missing_is_empty_string() -> None:
    empty: Any = {}
    exc = ClientError(empty, "HeadObject")
    assert _error_code(exc) == ""
    assert _http_status(exc) is None


# --- pre-flight guards (reject before any client opens) ----------------------


async def test_put_rejects_oversized(monkeypatch: pytest.MonkeyPatch) -> None:
    # Shrink the ceiling so we don't allocate 5 GiB. put() must reject BEFORE it
    # ever touches a client (so this needs no network).
    monkeypatch.setattr(s3_backend, "MAX_PUT_BYTES", 4)
    backend = S3ObjectStorage.from_config(_s3())
    with pytest.raises(StorageUploadError):
        await backend.put("k.txt", b"too large")


async def test_signed_url_rejects_over_ceiling() -> None:
    backend = S3ObjectStorage.from_config(_s3())
    with pytest.raises(StorageSignError):
        await backend.signed_read_url("k.txt", expires_in=timedelta(days=8))


async def test_signed_url_rejects_non_positive() -> None:
    backend = S3ObjectStorage.from_config(_s3())
    with pytest.raises(StorageSignError):
        await backend.signed_read_url("k.txt", expires_in=timedelta(0))
