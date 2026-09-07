"""Redis coordination configuration model.

WHY THIS EXISTS
`Settings.redis` is typed `RedisConfig | None`; pydantic-settings validates one
`REDIS__*` env block against it (the single config funnel — no hand-written
`TypeAdapter` on the env path). Redis is the genuinely-optional coordination
integration: `| None` keeps dev/test booting without it, and the single prod gate
in `src.config` requires it in production.

Redis coordinates the one-sandbox-per-user lock, idle heartbeat, and sandbox
registry; the single-replica POC uses in-process asyncio for progress, so there
are NO pub/sub channels.

`url` is a `SecretStr` (a Redis DSN may embed a password); it is unwrapped only at
the pool boundary in `client.py`.
"""

from __future__ import annotations

from pydantic import (
    BaseModel,
    ConfigDict,
    NonNegativeInt,
    PositiveFloat,
    PositiveInt,
    SecretStr,
)


class RedisConfig(BaseModel):
    """Redis connection + pool knobs. `url` is required (no default — fail-first);
    the pool knobs keep POC-sensible defaults."""

    # `extra="forbid"` makes a mistyped REDIS__* nested key fail at startup instead
    # of silently defaulting (fail-first).
    model_config = ConfigDict(extra="forbid")

    # Redis DSN, e.g. redis://:pass@host:6379/0 or rediss://… — may embed a
    # password, so it is masked; unwrapped only in the pool factory.
    url: SecretStr
    # Connection-pool ceiling (the POC bounds concurrency at one sandbox per user,
    # so a small pool is enough). `PositiveInt` rejects a nonsensical zero/negative.
    max_connections: PositiveInt = 10
    # Per-operation socket timeout in seconds — a hung Redis must not wedge a
    # coordination call forever. `PositiveFloat` rejects zero/negative. 2.0 is half
    # of the retry-policy budget below; see the worst-case arithmetic there.
    socket_timeout_seconds: PositiveFloat = 2.0
    # Socket CONNECT timeout in seconds (bounds opening the TCP/TLS socket, as
    # opposed to waiting for a reply on an open one). Distinct knob because a dead
    # host burns only this one, while a hung server burns both.
    socket_connect_timeout_seconds: PositiveFloat = 2.0

    # --- Retry policy (the whole point of these three knobs) -------------------
    # A `from_url` client gets ZERO retries by default: redis-py injects its
    # advertised `Retry(ExponentialWithJitterBackoff(), retries=10)` only on the
    # `if not connection_pool:` branch of `Redis.__init__`, and `from_url` ALWAYS
    # builds a pool, so it lands on `Retry(NoBackoff(), 0)` — one attempt, no
    # backoff, measured failure in 0.006s against a dead port. `client.py` therefore
    # passes an EXPLICIT `Retry(...)` built from these knobs.
    #
    # Total attempts = retry_attempts + 1, so 0 is a legitimate operator escape
    # hatch ("fail on the first error, like before") — `NonNegativeInt`, not
    # `PositiveInt`. Worst case against a dead host, with the defaults:
    #   4 x socket_connect_timeout + backoff sum (0.05+0.1+0.2, jittered, capped
    #   at 0.5) ≈ 8.7s; ≈ 16.7s against a server that hangs on both timeouts.
    # The library default (10 retries) would be ~60s — unacceptable on a request path.
    retry_attempts: NonNegativeInt = 3
    # Exponential-with-jitter backoff base, in seconds (delay f ≈ base * 2**f).
    retry_backoff_base_seconds: PositiveFloat = 0.05
    # Ceiling on any single backoff sleep, in seconds — keeps the tail bounded.
    retry_backoff_cap_seconds: PositiveFloat = 0.5

    def require_tls(self) -> None:
        """Raise unless this DSN uses the TLS scheme. Called by each role's production gate.

        TLS to Redis is carried by the DSN SCHEME, not by kwargs — no per-environment TLS
        settings exist in `services/redis/client.py` — so this validator is the only place
        plaintext can be caught. A METHOD here (not a per-role helper) keeps the API and
        worker from drifting into two opinions about the same instance. STATIC message
        only: never interpolate the DSN — it is a `SecretStr` and may embed a password.
        """
        if not self.url.get_secret_value().startswith("rediss://"):
            raise ValueError(
                "REDIS__URL must use the TLS scheme rediss:// in production: a plaintext redis:// "
                "connection would expose the coordination keys and any DSN-embedded password on "
                "the wire. Azure Cache for Redis serves TLS on port 6380."
            )
