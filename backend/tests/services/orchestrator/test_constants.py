"""The open-sandbox write gate + read ignore set — the whole workspace is
writable, so the guard only keeps the model out of `.git/**` and any absolute/`..` escape."""

from __future__ import annotations

import pytest

from src.services.orchestrator import constants


def test_frozen_budgets_are_in_module_not_config() -> None:
    # The self-heal budget + per-run ceiling are in-module constants; none reads config.py.
    assert constants.SELF_HEAL_MAX_RETRIES == 3
    assert constants.MODEL_TURN_CEILING > 0
    assert constants.TYPECHECK_CMD == ("npx", "tsc", "--noEmit")
    assert constants.EXEC_TIMEOUT_S < 900  # within the supervisor contract's hard exec cap


def test_cache_ttl_is_the_one_hour_tier() -> None:
    # The prompt-cache TTL is the 1h tier, NOT the 5m one `True` selects. The loop's steps are
    # far apart (a 600s `run_command` npm install, an EXEC_TIMEOUT_S tsc, readiness polls), so a 5m
    # entry would expire between steps — every step paying the write premium for zero reads.
    assert constants.CACHE_TTL == "1h"
    # A whole build is deadline-bounded well inside one 1h window → one write, then reads.
    assert constants.RUN_WALL_CLOCK_DEADLINE_S < 3600


def test_cache_settings_are_module_constants_not_config_fields() -> None:
    # The cache knobs live in THIS module, not in Settings — the config surface is deliberately
    # frozen here, so a cache field must never leak into Settings as a misconfiguration.
    from src.config import Settings

    assert not [name for name in Settings.model_fields if "cache" in name.lower()]


@pytest.mark.parametrize(
    "path",
    [
        "app/records/page.tsx",
        "app/page.tsx",
        "components/widgets/data-table.tsx",
        "lib/format.ts",
        "./app/records/page.tsx",  # normalizes to a writable path
        # The open-sandbox surface: everything previously in the never-edit set is now writable.
        "db/schema.ts",  # the Drizzle schema — un-frozen, the AI owns it now
        "components/ui/button.tsx",  # shadcn primitive — editable
        "components/bial/error-capture.tsx",  # platform shim — editable
        "package.json",  # the AI-editable source of truth for deps
        "package-lock.json",
        "next.config.ts",
        "tsconfig.json",
        "postcss.config.mjs",
        "components.json",
        ".env",  # writable-but-non-persisted (snapshot excludes .env*); supervisor is the boundary
        ".gitignore",  # a dotfile that must NOT be caught by the `.git` deny
        ".github/workflows/ci.yml",  # `.git`-prefixed but not `.git/` — writable
        "README.md",  # a root file, now writable
        "app/../db/schema.ts",  # `..` that resolves back inside → writable
    ],
)
def test_write_allowed_across_the_open_surface(path: str) -> None:
    assert constants.is_write_allowed(path) is True


@pytest.mark.parametrize(
    "path",
    [
        ".git",  # the bare git dir
        ".git/config",  # the exfiltration/history-corruption path
        ".git/hooks/pre-push",
        "app/../../etc/passwd",  # `..` escape out of the workspace
        "/etc/passwd",  # absolute
        "/workspace/app/app/page.tsx",  # absolute even into the surface → denied (fail-closed)
        "",  # empty
    ],
)
def test_write_denied_only_for_git_and_escapes(path: str) -> None:
    assert constants.is_write_allowed(path) is False


@pytest.mark.parametrize(
    "path",
    [
        "node_modules/react/index.js",
        ".next/build-manifest.json",
        "dist/x.js",
        ".git/config",
        "package-lock.json",
        "app/node_modules/dep/x.ts",
        "pnpm-lock.yaml",
    ],
)
def test_read_ignored(path: str) -> None:
    assert constants.is_read_ignored(path) is True


@pytest.mark.parametrize(
    "path",
    ["app/page.tsx", "db/schema.ts", "components/ui/button.tsx", "README.md"],
)
def test_read_allowed(path: str) -> None:
    # A read can't mutate — even the never-edit files are readable so the model can learn
    # the data API before composing against it.
    assert constants.is_read_ignored(path) is False


@pytest.mark.parametrize(
    "path",
    [
        "/etc/passwd",  # absolute — must be denied, not read as a relative path
        "/proc/self/environ",  # the supervisor token lives here; never readable
        "/workspace/.env",  # absolute into the workspace root
        "app/../../etc/shadow",  # `..` escape out of the workspace
        "..",  # bare parent
        "",  # empty
    ],
)
def test_read_ignored_denies_absolute_and_traversal_paths(path: str) -> None:
    # The read guard normalizes through the SAME fail-closed `_normalize_rel` as the write guard,
    # so an absolute or `..`-escaping path is denied — it is no longer silently stripped to a
    # readable relative path (the fixed asymmetry with is_write_allowed).
    assert constants.is_read_ignored(path) is True
