"""Storage integration-suite fixtures. The `ready_backend` fixture yields a real
backend (S3ObjectStorage against MinIO, AzureBlobStorage against Azurite) with a
freshly-created bucket/container, and skips cleanly when the service isn't
reachable so `-m integration` without docker-compose gives a clear skip rather
than a hang. It resets the module client cache around each test so a client built
on one test's event loop is never reused on the next loop.

These tests touch no database; only the `ready_backend` fixture (and thus the
integration lane) needs MinIO/Azurite.
"""

from __future__ import annotations

import socket
import uuid
from collections.abc import AsyncIterator

import pytest
from azure.core.exceptions import ResourceExistsError
from botocore.exceptions import ClientError
from pydantic import SecretStr

from src.services.storage import reset_storage_for_tests
from src.services.storage.azure_backend import AzureBlobStorage
from src.services.storage.base import ObjectStorage
from src.services.storage.config import AzureStorageConfig, S3StorageConfig
from src.services.storage.s3_backend import S3ObjectStorage

MINIO_ENDPOINT = "http://localhost:9000"
MINIO_KEY = "minioadmin"
MINIO_SECRET = "minioadmin"  # noqa: S105 - well-known local docker-compose dev creds

# Azurite's well-known dev account (public, baked into the image).
AZURITE_ACCOUNT_URL = "http://127.0.0.1:10000/devstoreaccount1"
AZURITE_CONN = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/"
    "K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
)


def _port_open(host: str, port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex((host, port)) == 0


async def _ensure_s3_bucket(backend: S3ObjectStorage, bucket: str) -> None:
    client = await backend._client()
    try:
        await client.create_bucket(Bucket=bucket)
    except ClientError as exc:
        # already exists (unique names make this defensive only); re-raise anything
        # that is NOT an already-exists code.
        code = exc.response.get("Error", {}).get("Code", "")
        if code not in {"BucketAlreadyOwnedByYou", "BucketAlreadyExists"}:
            raise


async def _ensure_azure_container(backend: AzureBlobStorage, container: str) -> None:
    state = await backend._state()
    try:
        await state.service_client.create_container(container)
    except ResourceExistsError:
        pass


@pytest.fixture(params=["s3", "azure"])
async def ready_backend(request: pytest.FixtureRequest) -> AsyncIterator[ObjectStorage]:
    # Fresh client cache per test so a client from a prior test's event loop is
    # never reused on this loop.
    await reset_storage_for_tests()
    provider: str = request.param

    if provider == "s3":
        if not _port_open("localhost", 9000):
            pytest.skip(
                "MinIO not reachable on :9000 — `docker compose -f docker-compose.test.yml up -d`"
            )
        bucket = f"test-{uuid.uuid4().hex[:16]}"
        s3_backend = S3ObjectStorage.from_config(
            S3StorageConfig(
                bucket=bucket,
                region="us-east-1",
                access_key_id=SecretStr(MINIO_KEY),
                secret_access_key=SecretStr(MINIO_SECRET),
                endpoint_url=MINIO_ENDPOINT,
            )
        )
        await _ensure_s3_bucket(s3_backend, bucket)
        try:
            yield s3_backend
        finally:
            await s3_backend.aclose()
            await reset_storage_for_tests()
        return

    if not _port_open("127.0.0.1", 10000):
        pytest.skip(
            "Azurite not reachable on :10000 — `docker compose -f docker-compose.test.yml up -d`"
        )
    container = f"test-{uuid.uuid4().hex[:16]}"
    azure_backend = AzureBlobStorage.from_config(
        AzureStorageConfig(
            account_url=AZURITE_ACCOUNT_URL,
            container=container,
            connection_string=SecretStr(AZURITE_CONN),
        )
    )
    await _ensure_azure_container(azure_backend, container)
    try:
        yield azure_backend
    finally:
        await azure_backend.aclose()
        await reset_storage_for_tests()
