"""App-level sandbox-client lifecycle hook.

The FastAPI lifespan (main.py) closes the app-global sandbox client on shutdown
alongside the Redis pool and the object store, so no long-lived HTTP pool leaks.
The concrete `AcaSandboxClient` is now wired in, so `aclose_sandbox()`
delegates to the client's isolated singleton close (`aclose_sandbox_singleton`) and
actually tears down the supervisor HTTP pool + the ACA client/credential — it is no
longer a no-op. Freezing this hook's interface ahead of that implementation meant
main.py's lifespan never needed re-opening to land this.
"""

from __future__ import annotations

from src.services.sandbox.client import aclose_sandbox_singleton


async def aclose_sandbox() -> None:
    """Close the app-global sandbox client (its HTTP pool + ACA client/credential) on
    shutdown. Delegates to the concrete client's isolated singleton close.
    Safe to call when no client was ever opened (mirrors `aclose_storage` /
    `aclose_redis`)."""
    await aclose_sandbox_singleton()
