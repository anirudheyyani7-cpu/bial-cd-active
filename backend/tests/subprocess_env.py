"""The environment a child interpreter needs to START, and nothing else.

Several suites spawn a fresh interpreter to prove something about a cold import, so the
child inherits NOTHING from the parent — `subprocess.run` gets a hand-built `env=`, never
a copy of `os.environ`.

On Windows, Winsock needs `SystemRoot` before `asyncio` can import `_overlapped`; without it
these tests fail with a WinError that looks like a broken checkout, not a portability bug —
it was misread as exactly that, twice. POSIX needs no such variable.

This module adds ONLY what the OS needs to boot Python; `PATH` and project-level variables
stay explicit at each call site."""

from __future__ import annotations

import os

# Only Windows needs this — see the module docstring.
_OS_REQUIRED: tuple[str, ...] = ("SystemRoot",) if os.name == "nt" else ()


def child_env(**overrides: str) -> dict[str, str]:
    """`PATH` + whatever the host OS needs to boot Python + the caller's own variables.

    Deliberately NOT a copy of `os.environ`: the isolation these tests rely on is the whole
    reason they build an env by hand. Pass the project variables as keyword arguments, e.g.
    `child_env(ENV_FILE=".env.test")`.
    """
    env = {"PATH": os.environ["PATH"]}
    env.update({name: os.environ[name] for name in _OS_REQUIRED if name in os.environ})
    env.update(overrides)
    return env
