"""Object-storage safety bounds — fixed in every deploy, so they are code
constants, not env config (12-factor: config is what varies between deploys).
Changed only by a code edit + review, never by ops at runtime.

(badger's per-segment / total object-key byte ceilings are dropped here: they
guarded the multi-tenant `scoped_key`, whose forgeable string axes this
single-tenant port replaces with UUID-typed key builders — a canonical UUID
cannot carry `/`, `..`, or control chars, so the length/traversal guards have
nothing left to guard. See `keys.py`.)
"""

from __future__ import annotations

from datetime import timedelta
from typing import Final

# Hard ceiling on signed read-URL lifetime. The ABC rejects any larger
# `expires_in` with StorageSignError BEFORE delegating to a backend — fail
# closed, never silently clamped. Matches the S3/R2 presigned-GET sig-v4 limit
# and bounds an Azure SAS so a leaked URL self-expires within a week.
MAX_SIGNED_URL_TTL: Final = timedelta(days=7)

# Upper bound on a single `put`. The S3 single-PutObject limit is 5 GiB
# (multipart is a deferred follow-up); enforced identically on Azure for a
# uniform contract.
MAX_PUT_BYTES: Final = 5 * 1024 * 1024 * 1024  # 5 GiB

# Default page size for prefix listings when the caller does not specify one.
DEFAULT_PAGE_SIZE: Final = 1000
