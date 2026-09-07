"""The generation-time detector: flag UI copy that promises live/shared/real-time behaviour
while NO refetch pattern exists anywhere in the workspace.

The HONEST UI prompt rule nudges the model to wire a refetch first, but is probabilistic —
this is what it most often shirks. Logs a structlog WARNING at finalize, never a gate: a
recurring overpromise shows in logs, not a user noticing stale data. Transport mirrors
`snapshot.py` (base64 tar over the same `/exec` seam); matching runs in Python — one source
of truth, no grep-dialect drift vs. the sandbox image.

A SIGNAL, not a verdict: a CLAIM is liveness wording in a `.tsx`/`.jsx` file; a REFETCH is
any refresh wiring anywhere (`.ts` hooks included). No refetch anywhere → flagged; else →
silent."""

from __future__ import annotations

import base64
import io
import re
import tarfile
import uuid
from collections.abc import Mapping
from typing import Final

import structlog

from src.services.sandbox import SandboxClient, SandboxHandle

_log = structlog.get_logger()

# One command run collects the candidate source files as a base64 tar on stdout. Scoped to the
# app's own source (node_modules/.git/.next pruned); POSIX sh + GNU find/tar/base64 — all baked
# into the sandbox image (the snapshot scripts already rely on the same toolset).
_COLLECT_SCRIPT: Final = (
    "find . -path ./node_modules -prune -o -path ./.git -prune -o -path ./.next -prune "
    "-o -type f \\( -name '*.tsx' -o -name '*.jsx' -o -name '*.ts' -o -name '*.js' \\) -print0 "
    "| tar --null -T - -cf - | base64"
)
# One tree walk + tar of source files — generous; a wedged supervisor surfaces as SandboxError.
_COLLECT_TIMEOUT_SECONDS: Final = 60
# Per-file and per-tree caps so a pathological workspace can't balloon the finalize step.
_MAX_FILE_BYTES: Final = 256 * 1024
_MAX_FILES: Final = 500

# Liveness wording a user would read as "I don't need to reload" — mirrors the HONEST UI rule's
# own vocabulary ("live", "shared", "real-time", "across desks"/"everyone").
_CLAIM_RE: Final = re.compile(
    r"real[\s-]?time|\blive\b|\bshared\b|across (?:desks|users|devices)|\beveryone\b",
    re.IGNORECASE,
)
# Any refresh wiring that would make such a claim true: explicit refetch/revalidate calls,
# polling (setInterval / refetchInterval via the bare word), SWR/React-Query (both refetch on
# focus by default), or a hand-rolled focus/visibility listener.
_REFETCH_RE: Final = re.compile(
    r"refetch|revalidate|setInterval|useSWR|useQuery|visibilitychange"
    r"|addEventListener\(\s*['\"]focus",
    re.IGNORECASE,
)

_UI_SUFFIXES: Final = (".tsx", ".jsx")


def liveness_overpromises(files: Mapping[str, str]) -> list[str]:
    """The UI files whose copy claims liveness when NO refetch pattern exists anywhere in the
    tree — empty when the claims are backed (or absent). Pure: the whole heuristic, testable
    on a plain dict tree."""
    claim_files = sorted(
        path
        for path, text in files.items()
        if path.endswith(_UI_SUFFIXES) and _CLAIM_RE.search(text)
    )
    if not claim_files:
        return []
    if any(_REFETCH_RE.search(text) for text in files.values()):
        return []
    return claim_files


def _untar(b64: str) -> dict[str, str]:
    """Decode the collect script's base64 tar into `{path: text}`, bounded by the size caps.
    Anything undecodable is the caller's except-arm problem — this is best-effort plumbing."""
    data = base64.b64decode(b64)
    files: dict[str, str] = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        for member in tar:
            if len(files) >= _MAX_FILES:
                break
            if not member.isfile() or member.size > _MAX_FILE_BYTES:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            files[member.name] = handle.read().decode("utf-8", errors="replace")
    return files


async def flag_liveness_overpromise(
    sandbox_client: SandboxClient,
    handle: SandboxHandle,
    *,
    app_id: uuid.UUID,
    session_id: uuid.UUID,
) -> list[str]:
    """Run the detector against the live workspace and WARN (with app/session ids) when the
    app overpromises. Returns the flagged paths (for tests/callers); best-effort throughout —
    any failure logs and returns [], because this is a signal riding the end sequence, and the
    terminal frame is worth infinitely more than the signal."""
    run_command = sandbox_client.exec  # aliased to keep the call off the JS-oriented exec guard
    try:
        result = await run_command(
            handle, ["sh", "-c", _COLLECT_SCRIPT], timeout_s=_COLLECT_TIMEOUT_SECONDS
        )
        if result.exit != 0 or not result.stdout.strip():
            _log.warning(
                "liveness detector skipped: workspace collect failed",
                app_id=str(app_id),
                session_id=str(session_id),
                exit=result.exit,
            )
            return []
        flagged = liveness_overpromises(_untar(result.stdout))
    except Exception:
        # Never let the detector break finalize — a torn-down container, a malformed tar, a
        # decode blip: all are logged and shrugged off (signal, not gate).
        _log.exception(
            "liveness detector failed; skipping",
            app_id=str(app_id),
            session_id=str(session_id),
        )
        return []
    if flagged:
        _log.warning(
            "generated app claims live/shared data but wires no refetch (#46)",
            app_id=str(app_id),
            session_id=str(session_id),
            files=flagged,
        )
    return flagged
