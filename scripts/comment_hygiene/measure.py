"""Measure how much of each tracked source tree is comment or docstring.

Basis, stated because a before/after comparison is worthless if the two figures
were produced differently: a line counts as prose when comment or docstring
covers it and no code survives once that coverage is blanked, so a trailing
comment leaves its line counted as code. The denominator is every line of every
tracked source file in the surface, blanks included. Boundaries come from the
languages' own parsers, never a regex, so a `#` inside a string never counts.

Needs `portal/node_modules` for the TypeScript half, and an interpreter that can
parse this repo: there is no root project, so plain `uv run` picks a Python too
old for PEP 758. From the repository root:
`./backend/.venv/bin/python scripts/comment_hygiene/measure.py [--check]`.
"""

from __future__ import annotations

import argparse
import ast
import io
import json
import subprocess
import sys
import tokenize
from pathlib import Path

PY_SUFFIXES = (".py",)
TS_SUFFIXES = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")

# Per-surface ceilings. They differ because the surfaces are not comparable: a
# test's name is its documentation, so prose restating it is duplication by
# construction, while `src` carries explanation a caller genuinely cannot infer.
# `backend/src` is every backend source file that is not a test, migrations and
# operator scripts included; `portal/src` likewise absorbs the root build config.
TARGETS = {
    "backend/src": 30.0,
    "backend/tests": 12.0,
    "portal/src": 30.0,
    "portal/tests": 12.0,
    "sandbox": 18.0,
}
UNDERSHOOT_FLAG = 2.0

NODE_COUNTER = r"""
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const require = createRequire(path.join(process.cwd(), "portal", "noop.js"));
const ts = require("typescript");
const KIND = { ".ts": ts.ScriptKind.TS, ".tsx": ts.ScriptKind.TSX,
               ".js": ts.ScriptKind.JS, ".jsx": ts.ScriptKind.JSX,
               ".mjs": ts.ScriptKind.JS, ".cjs": ts.ScriptKind.JS };
const out = {};
for (const rel of JSON.parse(readFileSync(0, "utf8"))) {
  const text = readFileSync(rel, "utf8");
  const kind = KIND[path.extname(rel)] ?? ts.ScriptKind.TSX;
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, kind);
  const chars = [...text];
  // Blank the prose but keep the newlines -- the line count is the denominator.
  const blank = (a, b) => {
    for (let i = a; i < b; i += 1) if (chars[i] !== "\n") chars[i] = " ";
  };
  const walk = (node) => {
    for (const r of ts.getLeadingCommentRanges(text, node.pos) ?? []) blank(r.pos, r.end);
    for (const r of ts.getTrailingCommentRanges(text, node.end) ?? []) blank(r.pos, r.end);
    for (const d of node.jsDoc ?? []) blank(d.pos, d.end);
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      blank(node.getStart(source), node.getEnd());
    }
    for (const child of node.getChildren(source)) walk(child);
  };
  walk(source);
  const before = text.split("\n");
  const after = chars.join("").split("\n");
  let prose = 0;
  for (let i = 0; i < before.length; i += 1) {
    if (before[i].trim() && !after[i].trim()) prose += 1;
  }
  out[rel] = [before.length, prose];
}
process.stdout.write(JSON.stringify(out));
"""


def surface_of(path: str) -> str | None:
    """Which surface a repo-relative path belongs to, or None if untargeted."""
    is_test = "__tests__/" in path or ".test." in path or ".spec." in path
    if path.startswith("backend/tests/"):
        return "backend/tests"
    if path.startswith("backend/"):
        return "backend/src"
    if path.startswith("sandbox/"):
        return "sandbox"
    if path.startswith(("portal/e2e/", "portal/tests/")) or (
        path.startswith("portal/") and is_test
    ):
        return "portal/tests"
    if path.startswith("portal/"):
        return "portal/src"
    return None


def _prose_ranges_python(text: str) -> list[tuple[int, int]]:
    """Character ranges of every comment and docstring, from the real tokenizer."""
    offsets = [0, 0]
    for line in text.splitlines(keepends=True):
        offsets.append(offsets[-1] + len(line))
    lines = text.splitlines(keepends=True)
    ranges = [
        (offsets[t.start[0]] + t.start[1], offsets[t.end[0]] + t.end[1])
        for t in tokenize.generate_tokens(io.StringIO(text).readline)
        if t.type == tokenize.COMMENT
    ]

    def char_col(row: int, byte_col: int) -> int:
        line = lines[row - 1] if row - 1 < len(lines) else ""
        return len(line.encode("utf-8")[:byte_col].decode("utf-8", errors="replace"))

    tree = ast.parse(text)
    for node in ast.walk(tree):
        for field in ("body", "orelse", "finalbody"):
            body = getattr(node, field, None)
            if not isinstance(body, list):
                continue
            for stmt in body:
                if not (
                    isinstance(stmt, ast.Expr)
                    and isinstance(stmt.value, ast.Constant)
                    and isinstance(stmt.value.value, str)
                ):
                    continue
                end_line = stmt.end_lineno or stmt.lineno
                ranges.append(
                    (
                        offsets[stmt.lineno] + char_col(stmt.lineno, stmt.col_offset),
                        offsets[end_line] + char_col(end_line, stmt.end_col_offset or 0),
                    )
                )
    return ranges


def count_python(path: Path) -> tuple[int, int]:
    """Total lines and prose lines in one Python file."""
    raw = path.read_bytes()
    with io.BytesIO(raw) as handle:
        encoding, _ = tokenize.detect_encoding(handle.readline)
    text = raw.decode(encoding)
    chars = list(text)
    for start, end in _prose_ranges_python(text):
        for index in range(start, end):
            # Blank the prose but keep the newlines: the line count is the
            # denominator, and a multi-line docstring must not collapse it.
            if chars[index] != "\n":
                chars[index] = " "
    before = text.split("\n")
    after = "".join(chars).split("\n")
    prose = sum(1 for b, a in zip(before, after, strict=True) if b.strip() and not a.strip())
    return len(before), prose


def count_typescript(root: Path, paths: list[str]) -> dict[str, tuple[int, int]]:
    """Total and prose lines for every TypeScript-family file, in one Node call."""
    if not paths:
        return {}
    result = subprocess.run(
        ["node", "--input-type=module", "-e", NODE_COUNTER],
        cwd=root,
        input=json.dumps(paths),
        capture_output=True,
        text=True,
        check=True,
    )
    return {k: (v[0], v[1]) for k, v in json.loads(result.stdout).items()}


def tracked(root: Path) -> list[str]:
    """Every tracked source file, repo-relative, sorted for a stable report."""
    listing = subprocess.run(
        ["git", "ls-files", "-z", *(f"*{s}" for s in PY_SUFFIXES + TS_SUFFIXES)],
        cwd=root,
        capture_output=True,
        text=True,
        check=True,
    )
    return sorted(name for name in listing.stdout.split("\0") if name)


def measure(root: Path) -> dict[str, dict[str, int]]:
    """Per-surface totals, plus an `other` row for tracked files no target covers."""
    tallies: dict[str, dict[str, int]] = {}
    ts_paths = []
    for rel in tracked(root):
        surface = surface_of(rel) or "other"
        tallies.setdefault(surface, {"files": 0, "lines": 0, "prose": 0})
        if rel.endswith(PY_SUFFIXES):
            total, prose = count_python(root / rel)
            tallies[surface]["files"] += 1
            tallies[surface]["lines"] += total
            tallies[surface]["prose"] += prose
        else:
            ts_paths.append(rel)

    for rel, (total, prose) in count_typescript(root, ts_paths).items():
        surface = surface_of(rel) or "other"
        tallies.setdefault(surface, {"files": 0, "lines": 0, "prose": 0})
        tallies[surface]["files"] += 1
        tallies[surface]["lines"] += total
        tallies[surface]["prose"] += prose
    return tallies


def report(tallies: dict[str, dict[str, int]], check: bool) -> int:
    """Print the table; with --check, return 1 when any surface is over target."""
    order = [*TARGETS, "other"]
    print(f"{'surface':<16}{'files':>7}{'lines':>9}{'prose':>9}{'share':>8}{'target':>8}  verdict")
    failed = False
    repo_lines = repo_prose = 0
    for surface in order:
        row = tallies.get(surface)
        if not row:
            continue
        share = 100.0 * row["prose"] / row["lines"] if row["lines"] else 0.0
        target = TARGETS.get(surface)
        if target is None:
            verdict = "not targeted"
        elif share > target:
            verdict, failed = "OVER", True
        elif share < target - UNDERSHOOT_FLAG:
            verdict = "under by >2pt -- check explanation was not cut"
        else:
            verdict = "ok"
        if surface in TARGETS:
            repo_lines += row["lines"]
            repo_prose += row["prose"]
        shown = f"{target:.0f}%" if target is not None else "--"
        print(
            f"{surface:<16}{row['files']:>7}{row['lines']:>9}{row['prose']:>9}"
            f"{share:>7.1f}%{shown:>8}  {verdict}"
        )
    repo_share = 100.0 * repo_prose / repo_lines if repo_lines else 0.0
    over = repo_share > 20.0
    failed = failed or over
    print(
        f"{'WHOLE REPO':<16}{'':>7}{repo_lines:>9}{repo_prose:>9}"
        f"{repo_share:>7.1f}%{'20%':>8}  {'OVER' if over else 'ok'}"
    )
    print("\nWHOLE REPO is the five targeted surfaces; `other` is reported, not targeted.")
    return 1 if (check and failed) else 0


def main() -> int:
    if sys.version_info < (3, 14):
        # Not a style preference: the tree uses PEP 758 `except A, B:`, which older
        # parsers reject, and the failure surfaces as a SyntaxError in a scanned file
        # rather than here -- which reads as a corrupt repo rather than a wrong python.
        print(
            f"needs Python 3.14+ to parse this repo; got {sys.version.split()[0]}. "
            "Try ./backend/.venv/bin/python scripts/comment_hygiene/measure.py",
            file=sys.stderr,
        )
        return 2
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="repository root")
    parser.add_argument("--check", action="store_true", help="exit 1 if a surface is over target")
    parser.add_argument("--json", action="store_true", help="emit the raw tallies")
    args = parser.parse_args()
    root = Path(args.root).resolve()
    tallies = measure(root)
    if args.json:
        print(json.dumps(tallies, indent=2, sort_keys=True))
        return 0
    return report(tallies, args.check)


if __name__ == "__main__":
    sys.exit(main())
