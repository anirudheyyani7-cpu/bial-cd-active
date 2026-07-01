"""Security-load-bearing owner-scoping tests. Single-tenant isolation lives in the
`att/{user_id}/` key prefix, so these are attack-shaped: cross-owner access, the
trailing-slash boundary that defeats a prefix collision, the bare owner root that
is not itself an object, and the metadata charset round-trip both backends rely on.
"""

from __future__ import annotations

import uuid

import pytest

from src.services.storage.errors import StorageError
from src.services.storage.keys import (
    app_file_key,
    assert_owned,
    attachment_key,
    normalize_metadata,
    normalize_metadata_key,
    owner_prefix,
)

# Fixed UUIDs so the tests are deterministic. U1 and U2 are DISTINCT; the point of
# the boundary check is that no key under U2 ever passes for U1.
_U1 = uuid.UUID("019f1c00-0000-7000-8000-000000000001")
_U2 = uuid.UUID("019f1c00-0000-7000-8000-000000000002")
_ATT = uuid.UUID("019f1c00-0000-7000-8000-0000000000aa")
_APP = uuid.UUID("019f1c00-0000-7000-8000-0000000000bb")
_FILE = uuid.UUID("019f1c00-0000-7000-8000-0000000000cc")


# --- key builders ------------------------------------------------------------


def test_owner_prefix_has_trailing_slash() -> None:
    assert owner_prefix(_U1) == f"att/{_U1}/"


def test_attachment_key_is_owner_scoped() -> None:
    assert attachment_key(_U1, _ATT) == f"att/{_U1}/{_ATT}"


def test_app_file_key_uses_apps_namespace() -> None:
    assert app_file_key(_APP, _FILE) == f"apps/{_APP}/{_FILE}"


# --- assert_owned: happy path ------------------------------------------------


def test_assert_owned_accepts_the_users_own_key() -> None:
    assert_owned(attachment_key(_U1, _ATT), _U1)  # no raise


# --- assert_owned: fail-closed -----------------------------------------------


def test_assert_owned_rejects_another_owners_key() -> None:
    # The canonical cross-user leak: a key minted for U2 must never pass for U1.
    with pytest.raises(StorageError):
        assert_owned(attachment_key(_U2, _ATT), _U1)


def test_assert_owned_rejects_bare_owner_root() -> None:
    # The bare `att/{user_id}/` prefix carries no object beyond it — not a valid
    # object key (the length check, not just the prefix, is what rejects it).
    with pytest.raises(StorageError):
        assert_owned(owner_prefix(_U1), _U1)


def test_assert_owned_rejects_prefix_without_trailing_slash() -> None:
    # `att/{user_id}` (no slash) must not pass: the trailing-slash boundary is
    # what stops one owner id being a prefix of another.
    with pytest.raises(StorageError):
        assert_owned(f"att/{_U1}", _U1)


def test_assert_owned_rejects_app_file_key_for_a_user() -> None:
    # App-file keys live under `apps/`, not `att/{user_id}/` — an owner check on
    # one must fail closed.
    with pytest.raises(StorageError):
        assert_owned(app_file_key(_APP, _FILE), _U1)


# --- metadata key normalization ----------------------------------------------


def test_metadata_key_lowercased() -> None:
    assert normalize_metadata_key("RunId") == "runid"


def test_metadata_key_underscore_ok() -> None:
    assert normalize_metadata_key("run_id_2") == "run_id_2"


@pytest.mark.parametrize(
    "bad_key", ["has-hyphen", "1starts_with_digit", "has space", "dot.key", ""]
)
def test_metadata_key_invalid_charset_rejected(bad_key: str) -> None:
    with pytest.raises(StorageError):
        normalize_metadata_key(bad_key)


def test_normalize_metadata_roundtrips_and_rejects() -> None:
    assert normalize_metadata({"RunId": "abc", "Stage": "qa"}) == {"runid": "abc", "stage": "qa"}
    assert normalize_metadata(None) is None
    with pytest.raises(StorageError):
        normalize_metadata({"bad-key": "x"})
