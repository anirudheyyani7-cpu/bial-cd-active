"""The front door to application configuration.

Settings live in `src/settings/`: a `CoreSettings` every process needs, plus ONE MANIFEST PER
ROLE (`api.py`, `worker.py`). This module stays because 105 modules import `settings` from it.

`settings` is LAZY, and that's load-bearing: eager construction would build the union of every
role's needs — twelve worker imports do `from src.config import settings`, forcing API-only
fields (an Entra client id) into a process with no request to authenticate. It defers to first
attribute access, once `BIAL_ROLE` is known, and is typed `ApiSettings` even in a worker (a
deliberate trade over migrating 105 call sites — worker code wanting safety uses
`src.settings.WorkerSettings` explicitly).
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING, Any, cast

from src.settings.api import ApiSettings
from src.settings.core import ROLE_ENV_VAR
from src.settings.foundry import FoundryConfig as FoundryConfig
from src.settings.worker import WorkerSettings

if TYPE_CHECKING:  # pragma: no cover - typing only
    pass

# Back-compat alias: four modules do `from src.config import Settings`. The API profile IS the
# settings object those call sites mean.
Settings = ApiSettings

_profile: ApiSettings | WorkerSettings | None = None


def build_profile() -> ApiSettings | WorkerSettings:
    """Construct the profile for THIS process's role, from the environment alone.

    Read from the environment, not passed in: Python 3.14's POSIX multiprocessing start method
    is `forkserver`, so a child inherits nothing and a settings object built or memoized in a
    parent never survives into it — every process builds its own. Role defaults to `api`; a
    deployment sets `BIAL_ROLE=worker` only on the worker's container.
    """
    if os.getenv(ROLE_ENV_VAR, "api").strip().lower() == "worker":
        return WorkerSettings()  # pyright: ignore[reportCallIssue]
    return ApiSettings()  # pyright: ignore[reportCallIssue]


def resolve_settings() -> ApiSettings | WorkerSettings:
    """Build this process's profile once, then hand back the same object.

    Not `functools.cache`d: the memo is a plain module global so a test can reset it, and so the
    resolution point is obvious to a reader chasing a boot failure.
    """
    global _profile
    if _profile is None:
        _profile = build_profile()
    return _profile


class _SettingsProxy:
    """Forwards every attribute to the role's profile, constructing it on first access.

    `__getattr__` runs only when normal lookup fails, and this class defines no instance state, so
    every read goes through it. Deliberately NOT a `__getattr__`-on-the-module trick: `from
    src.config import settings` binds the object at the consumer's import time, so a module-level
    hook would resolve just as eagerly as the old global did.
    """

    __slots__ = ()

    def __getattr__(self, name: str) -> Any:
        return getattr(resolve_settings(), name)

    def __setattr__(self, name: str, value: Any) -> None:
        # Forwarded, not stored. `monkeypatch.setattr(settings, "spa_dist_dir", ...)` is used
        # widely across the suite, and a proxy that swallowed the write would leave every such
        # test asserting against the unpatched value — a silent false pass, which is worse than
        # the AttributeError a read-only proxy would raise.
        setattr(resolve_settings(), name, value)

    def __delattr__(self, name: str) -> None:
        delattr(resolve_settings(), name)

    def __dir__(self) -> list[str]:
        # So `dir(settings)` and interactive completion show the profile's fields rather than the
        # proxy's empty surface.
        return dir(resolve_settings())

    def __repr__(self) -> str:
        # Never eagerly resolve just to render a repr — a logger touching this must not be able to
        # trigger a boot failure.
        state = "unresolved" if _profile is None else type(_profile).__name__
        return f"<settings proxy: {state}>"


# The one type assertion this design costs. See TYPING above.
settings = cast(ApiSettings, _SettingsProxy())
