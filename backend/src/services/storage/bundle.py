"""Git-bundle header validation + commit-SHA parse.

A v2 git bundle opens with a plaintext header before the binary packfile:

    # v2 git bundle
    [-<sha> <comment>]        prerequisites (absent for our HEAD-only bundles)
    <sha> HEAD                the ref line submit needs
    <blank line>
    <binary packfile>

WHY THIS EXISTS — `parse_bundle_head_sha` is submit's only SHA provenance (the sandbox is gone by
submit time; `write_snapshot` records no SHA), and the header is ATTACKER-WRITABLE. The token is
validated to exactly 40 lowercase hex chars, never logged unsanitized, and only a bounded prefix
is scanned so a pathological "header" can't force a full-object scan. Stored bytes are the RAW
bundle; a base64-encoded one fails the magic check here.
"""

from __future__ import annotations

import re

# The content type submit writes submission bundles with (raw bundle bytes).
BUNDLE_CONTENT_TYPE = "application/x-git-bundle"

_MAGIC = b"# v2 git bundle\n"
# The magic plus a handful of ref lines fit in well under 4 KiB. Anything that
# has not produced a `<sha> HEAD` line by this bound is not a bundle submit can
# accept — fail closed rather than scan on.
_MAX_HEADER_BYTES = 4096
_HEAD_SHA_RE = re.compile(rb"[0-9a-f]{40}")


class BundleValidationError(Exception):
    """The bytes are not a v2 git bundle carrying a well-formed `<sha> HEAD` ref.
    Deliberately NOT a StorageError: the store worked, the CONTENT failed the
    gate — submit maps this to a 409 ("rebuild and retry"), never a 503."""


def parse_bundle_head_sha(data: bytes) -> str:
    """Validate the v2 bundle header and return its HEAD commit SHA (40 lowercase
    hex chars). Raises `BundleValidationError` on anything malformed — never
    returns None: a truncated magic, a v3/SHA-256 bundle, a
    base64-transport shape, a header with no `HEAD` ref (refs may appear in any
    order; prerequisites are skipped), or a ref token that is not exactly 40
    lowercase hex chars. Only the first `_MAX_HEADER_BYTES` are examined."""
    header = data[:_MAX_HEADER_BYTES]
    if not header.startswith(_MAGIC):
        raise BundleValidationError("not a v2 git bundle (bad or missing header magic)")
    for line in header[len(_MAGIC) :].split(b"\n"):
        if not line:
            # The blank line ends the header — no HEAD ref was seen.
            break
        if line.startswith(b"-"):
            continue  # prerequisite line
        token, _, refname = line.partition(b" ")
        if refname != b"HEAD":
            continue
        if _HEAD_SHA_RE.fullmatch(token) is None:
            raise BundleValidationError("bundle HEAD ref token is not a 40-char lowercase hex SHA")
        return token.decode("ascii")
    raise BundleValidationError("bundle header carries no HEAD ref")
