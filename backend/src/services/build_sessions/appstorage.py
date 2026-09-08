"""Per-app Blob object-storage provisioning for a build session.

`provision_app_storage` ensures the app's Blob container and mints a fresh container-scoped SAS,
returning the two `BIAL_BLOB_*` env vars the sandbox injects into `next dev`.
"""

from __future__ import annotations

import uuid

from src.config import settings
from src.services.storage import get_app_container_store


async def provision_app_storage(app_id: uuid.UUID) -> dict[str, str]:
    """Ensure the app's container + mint a fresh container-scoped SAS; return
    `{BIAL_BLOB_CONTAINER_URL, BIAL_BLOB_SAS}`.

    Returns `{}` when object storage is unconfigured (dev/test): the app runs with no Blob vars
    rather than the start failing. A genuine storage error from a *configured* store is left to
    PROPAGATE — it fails the start before any sandbox handle exists, so there is nothing to tear
    down and the idempotent container is reused on the next start."""
    store = get_app_container_store()
    if store is None:
        return {}
    await store.ensure_container(app_id)
    sas = await store.mint_container_sas(app_id)
    # The injected container URL must name a host the SANDBOX can reach, not one the control
    # plane can: the sandbox-facing Blob base when configured, else the signing account's
    # account_url (the None default).
    sandbox = settings.sandbox
    base_url = sandbox.blob_base_url if sandbox is not None else None
    return {
        "BIAL_BLOB_CONTAINER_URL": store.container_url(app_id, base_url=base_url),
        "BIAL_BLOB_SAS": sas,
    }
