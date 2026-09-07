"""The shipped Caddyfile must ADAPT — the cheapest test here, and it would have caught a total
build-sandbox outage.

WHY THIS EXISTS. v1.6.12 shipped a `log` directive nested inside a `handle` block; `log` isn't
an ordered HTTP handler, so `caddy adapt` rejects the file on 2.8.4 and every later version.
`entrypoint.sh` backgrounds Caddy, so its non-zero exit is invisible to `set -eu`: nothing binds
:8080, the ACA startup probe (30 × 1s against `/_sup/health`) times out, the revision is
abandoned, and every provision fails with nothing saying why. Every prior Caddy assertion lived
in the `integration` lane — opt-in, Docker-gated, ~10-minute bake, absent from CI — so the
default lane never touched the Caddyfile. This test is deliberately NOT that lane: it shells out
to a tiny official Caddy image and asks one question in about a second, skipping if Docker is
missing.

It also pins the two properties the fix depends on — "it adapts" alone still passes if the
logger moves back under `handle` or `/_sup` logging is dropped:

  * the site has a logger at all (delete it and reclamation reads every container as idle), and
  * `/_sup/*` is excluded from it (delete `log_skip` and the platform's own probes count as user
    traffic, so an idle container looks busy forever — the exact failure the R14 signal guards).
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

# The Caddyfile lives one level up from tests/ (sandbox/Caddyfile).
CADDYFILE = Path(__file__).resolve().parent.parent / "Caddyfile"

# The version the image pins, plus the version it is moving to. BOTH must adapt: the fix must not
# depend on the bump, or a Caddy rollback would silently reintroduce the outage.
CADDY_VERSIONS = ("2.8.4", "2.11.4")


def _docker_available() -> bool:
    try:
        proc = subprocess.run(
            ["docker", "version", "--format", "{{.Server.Version}}"],
            capture_output=True,
            timeout=15,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):  # fmt: skip  # ruff py314 strips parens
        return False
    return proc.returncode == 0


def _adapt(version: str) -> subprocess.CompletedProcess[str]:
    """Run `caddy adapt` over the real Caddyfile in an official image."""
    return subprocess.run(
        [
            "docker", "run", "--rm", "--platform", "linux/amd64",
            "-v", f"{CADDYFILE}:/etc/caddy/Caddyfile:ro",
            f"caddy:{version}-alpine",
            "caddy", "adapt", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile",
        ],
        capture_output=True,
        text=True,
        timeout=180,
    )  # fmt: skip


@pytest.fixture(scope="module", autouse=True)
def _needs_docker() -> None:
    if not _docker_available():
        pytest.skip("Docker is not available — Caddyfile adapt check skipped")


@pytest.mark.parametrize("version", CADDY_VERSIONS)
def test_the_shipped_caddyfile_adapts(version: str) -> None:
    result = _adapt(version)
    assert result.returncode == 0, (
        f"sandbox/Caddyfile does not adapt on Caddy {version}. Caddy would fail to start, "
        f"nothing would bind :8080, and every ACA provision would die at the startup probe.\n"
        f"{result.stderr.strip()}"
    )


def _has_log_skip(node: object) -> bool:
    """True when `log_skip` is set anywhere in this subtree.

    `log_skip` adapts to `{"handler": "vars", "log_skip": true}` inside a nested `subroute`, not
    on the matched route itself, and the nesting depth differs between Caddy versions — so this
    walks the subtree rather than indexing a fixed path.
    """
    if isinstance(node, dict):
        if node.get("log_skip") is True:
            return True
        return any(_has_log_skip(v) for v in node.values())
    if isinstance(node, list):
        return any(_has_log_skip(item) for item in node)
    return False


def _matches_sup(route: dict[str, object]) -> bool:
    """True when this top-level route is the one matching `/_sup/*`."""
    return "/_sup" in json.dumps(route.get("match", []))


def test_the_site_logger_exists_and_skips_the_control_plane() -> None:
    """The access log must cover the app and exclude `/_sup/*` — asserted on the ADAPTED JSON,
    not the Caddyfile text, so it survives any spelling and can't be satisfied by a comment.

    THE SKIP MUST BE ON THE RIGHT ROUTE: an earlier `"skip" in json.dumps(server)` substring check
    couldn't tell `/_sup/*`'s skip from the app block's — the worse of the two, since that stops
    counting real traffic while counting probes as traffic (verified by mutation: `log_skip`
    moved into `handle` left the substring form green).
    """
    result = _adapt(CADDY_VERSIONS[-1])
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)

    server = next(iter(config["apps"]["http"]["servers"].values()))
    assert "logs" in server, (
        "the site has no access logger — request accounting would read every container as "
        "never-used, which fails toward reclaiming a container that is in active use"
    )

    routes: list[dict[str, object]] = server.get("routes", [])
    sup = [r for r in routes if _matches_sup(r)]
    app = [r for r in routes if not _matches_sup(r)]

    assert sup, "no route matches /_sup/* — the control-plane handler is gone"
    assert all(_has_log_skip(r) for r in sup), (
        "`/_sup/*` is not excluded from the access log — the platform's own 1-second startup "
        "probes (30 per provision) would be counted as user traffic and an idle container would "
        "look busy forever, so reclamation would never fire"
    )
    assert not any(_has_log_skip(r) for r in app), (
        "a `log_skip` is attached to the APP route. That is the worst config in the space: it "
        "stops counting the citizen's real requests AND starts counting platform probes, "
        "inverting the signal in both directions at once"
    )
