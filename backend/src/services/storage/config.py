"""Per-provider storage config models + the two-alias split that lets the typed
factory hand back a CONCRETE backend type while the dynamic (env/DB-sourced) path
honestly resolves to the base `ObjectStorage`.

The two aliases are deliberately kept separate (load-bearing for strict mode):

* `StorageConfigUnion` — the BARE union. Types the `create_storage` parameter and
  its fallback overload. A bare union is what keeps a future
  `TypeAdapter[StorageConfigUnion](StorageConfig)` (added only when a raw-dict /
  DB-creds path lands) free of the implicit-`Any` that `TypeAdapter(Annotated[...])`
  produces under `mypy --strict`.
* `StorageConfig` — the DISCRIMINATED form (`Annotated[..., Field(discriminator=
  "provider")]`). Types the `Settings.object_store` field; pydantic-settings
  validates one `OBJECT_STORE__*` env block against it. In v1 this single funnel
  is the ONLY place dynamic input becomes a typed config member — there is no
  hand-written `TypeAdapter`.

Every credential is a `SecretStr`, unwrapped only at the SDK boundary in the
backends (per security.md). Knob fields keep a default only where the empty/None
value has a DEFINED meaning the code branches on.
"""

from __future__ import annotations

from typing import Annotated, Literal, Self

from pydantic import BaseModel, Field, SecretStr, model_validator


class S3StorageConfig(BaseModel):
    """AWS S3. `endpoint_url=None` means the real AWS endpoint (virtual-hosted
    addressing); a non-None value targets an S3-compatible endpoint."""

    provider: Literal["s3"] = "s3"
    bucket: str
    region: str
    access_key_id: SecretStr
    secret_access_key: SecretStr
    endpoint_url: str | None = None  # None = real AWS endpoint (defined meaning)


class R2StorageConfig(BaseModel):
    """Cloudflare R2 (S3-compatible). The endpoint is derived from `account_id`
    + `jurisdiction` by the backend, so no `endpoint_url` field here."""

    provider: Literal["r2"] = "r2"
    account_id: str
    bucket: str
    access_key_id: SecretStr
    secret_access_key: SecretStr
    jurisdiction: Literal["default", "eu", "fedramp"] = "default"


class AzureStorageConfig(BaseModel):
    """Azure Blob Storage. Exactly one auth mode is enforced by the validator:
    `connection_string` (must embed an AccountKey), `account_key`, or
    `use_managed_identity`."""

    provider: Literal["azure"] = "azure"
    account_url: str
    container: str
    connection_string: SecretStr | None = None
    account_key: SecretStr | None = None
    use_managed_identity: bool = False

    @model_validator(mode="after")
    def _exactly_one_auth_mode(self) -> Self:
        modes = (
            self.connection_string is not None,
            self.account_key is not None,
            self.use_managed_identity,
        )
        if sum(modes) != 1:
            # STATIC message only — never interpolate any field value. pydantic
            # echoes validator messages into ValidationError (and thus logs).
            raise ValueError(
                "Azure storage requires exactly one auth mode: set exactly one of "
                "connection_string, account_key, or use_managed_identity."
            )
        if self.connection_string is not None:
            # A service SAS (for signed reads) needs a shared account key. A
            # SAS-based connection string has SharedAccessSignature= instead and
            # cannot mint one — fail fast. Scan for the key WITHOUT interpolating
            # any parsed substring (account key / SAS token) into the message.
            has_account_key = any(
                part.startswith("AccountKey=")
                for part in self.connection_string.get_secret_value().split(";")
            )
            if not has_account_key:
                raise ValueError(
                    "Azure connection_string must contain an AccountKey: a "
                    "SAS-based connection string cannot mint a service SAS for "
                    "signed reads."
                )
        return self


# BARE union — factory parameter + fallback overload. Do NOT add the
# discriminator Annotation here; the bare form is what a future raw-dict
# TypeAdapter needs to stay strict-clean.
StorageConfigUnion = S3StorageConfig | R2StorageConfig | AzureStorageConfig

# DISCRIMINATED form — the `Settings.object_store` field type. pydantic-settings
# validates the OBJECT_STORE__* env block against this (the single config funnel).
StorageConfig = Annotated[StorageConfigUnion, Field(discriminator="provider")]

# Literal of the provider discriminators — used by the gated `create_storage_for`
# string-sugar in factory.py.
StorageProvider = Literal["s3", "r2", "azure"]
