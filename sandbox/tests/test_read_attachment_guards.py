"""An already-named reader failure keeps its own name.

WHY THIS IS A SEPARATE MODULE FROM `test_read_attachment.py`. That one `importorskip`s all four
reader libraries at module scope, so on any machine missing one of them it reports "13 skipped" —
which reads like green and proves nothing. What is under test here is not parsing at all: it is
which exception classes the three readers let past, and that question needs no library. So the
libraries are STUBBED into `sys.modules` and these cases run everywhere, including on a developer
machine and in CI, where the suite next door cannot.

THE DEFECT. `read_delimited`, `read_docx` and `read_pptx` each wrapped their library call in one
broad `except Exception`, which catches `MemoryError` (the reader's own 512 MB ceiling) and
`ReadFailure` (its own 30-second deadline) along with everything else. Both came back to the
citizen as "this file could not be read — re-save it in its own application": a fact about the
platform, worded as a fact about their file, with advice they could follow all afternoon without
getting anywhere. `describe()` has always had the right arms; nothing ever reached them.
"""

from __future__ import annotations

import ast
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
from typing import Any

import pytest

READER = Path(__file__).resolve().parents[1] / "scripts" / "read_attachment.py"


def _load_reader() -> ModuleType:
    """The shipped script, imported as a module so `describe` can be called directly.

    `test_read_attachment.py` drives it as a subprocess, deliberately — that is how an agent runs
    it, and it keeps the argument handling and the exit code under test. Here the subject is an
    exception path that has to be INJECTED, so the module is imported instead.
    """
    spec = importlib.util.spec_from_file_location("bial_read_attachment", READER)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


reader_module = _load_reader()
ReadFailure = reader_module.ReadFailure

# Which library each reader reaches for, and the one entry point it calls on it. Stubbing at this
# seam means the guard is tested where it sits rather than through a real parse.
_ENTRY_POINT = {
    ".csv": ("polars", "scan_csv"),
    ".docx": ("docx", "Document"),
    ".pptx": ("pptx", "Presentation"),
}


def _raise_from_the_library(
    monkeypatch: pytest.MonkeyPatch, suffix: str, failure: BaseException
) -> None:
    """Make this suffix's reader library raise `failure` the moment it is called."""
    library, attribute = _ENTRY_POINT[suffix]

    def boom(*_args: Any, **_kwargs: Any) -> Any:
        raise failure

    monkeypatch.setitem(reader_module.sys.modules, library, SimpleNamespace(**{attribute: boom}))


def _a_file(tmp_path: Path, suffix: str) -> Path:
    """A real file, because `describe` refuses a missing one before it reaches any reader."""
    path = tmp_path / f"roster{suffix}"
    path.write_bytes(b"anything")
    return path


@pytest.mark.parametrize("suffix", [".csv", ".docx", ".pptx"])
@pytest.mark.parametrize("code", ["too_large", "timeout"])
def test_a_bound_that_fired_is_reported_as_itself_not_as_a_damaged_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str, code: str
) -> None:
    """★ SIX CASES, ALL WRONG BEFORE. A read killed by the memory ceiling and a read killed by the
    deadline are facts about the platform's limits; "re-save it in its own application" is not
    something a citizen can do about either, and following it produces the identical failure.

    The two are injected the way they really arrive: `MemoryError` from the allocator under
    `RLIMIT_DATA`, and a `ReadFailure('timeout')` raised into the parse by the `SIGALRM` handler.

    Mutation check: drop the guard from any one reader, or move it BELOW the broad arm where it is
    valid, dead and silent, and that reader's two cases go red.
    """
    failure: BaseException = (
        MemoryError()
        if code == "too_large"
        else ReadFailure("timeout", "Reading this file took too long.", "Attach a smaller file.")
    )
    _raise_from_the_library(monkeypatch, suffix, failure)

    with pytest.raises(ReadFailure) as caught:
        reader_module.describe(_a_file(tmp_path, suffix))

    assert caught.value.code == code
    assert caught.value.code != "unreadable"
    assert "re-save" not in caught.value.next_step.lower()


@pytest.mark.parametrize("suffix", [".csv", ".docx", ".pptx"])
def test_a_genuinely_damaged_file_still_gets_its_format_specific_remedy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, suffix: str
) -> None:
    """The guard narrows what the broad arm sees; it must not empty it. A library that fails
    because the bytes are rubbish is still `unreadable`, still with the advice that fits the
    format — which is also the receipt that the two cases above are a real narrowing rather than
    a reader that stopped catching anything."""
    _raise_from_the_library(monkeypatch, suffix, ValueError("not a valid file"))

    with pytest.raises(ReadFailure) as caught:
        reader_module.describe(_a_file(tmp_path, suffix))

    assert caught.value.code == "unreadable"
    assert "attach it again" in caught.value.next_step.lower()


def test_the_guards_parse_under_the_version_the_image_actually_ships() -> None:
    """★ THE PARENTHESES ARE LOAD-BEARING. The image ships Python 3.13, where a bindingless
    `except A, B:` is a hard SyntaxError; the backend that runs this suite is 3.14, where PEP 758
    makes it legal. So a stripped-paren clause would pass every check here and break the reader in
    the only environment it runs in.

    `ruff format` is never run over this file for the same reason (its formatter targets the
    backend's version and strips them), and this is the assertion that would catch it if it were.
    """
    source = READER.read_text(encoding="utf-8")

    assert "except (ReadFailure, MemoryError):" in source
    assert source.count("except (ReadFailure, MemoryError):") == 3
    assert "except ReadFailure, MemoryError:" not in source


# --- the reader streams, and that is load-bearing ------------------------------------


def test_the_workbook_is_streamed_never_materialised() -> None:
    """★ THE PROPERTY THE 10 MB CAP DEPENDS ON, pinned against the source.

    `read_only=True` walks the sheet XML a row at a time; `read_only=False` builds a cell object
    per cell. Measured in the shipped image on a dense 9.99 MB workbook (920,000 cells) at
    1 vCPU / 2 GiB: materialising peaked at 829 MB and was REFUSED by `MEMORY_LIMIT_BYTES`;
    streaming peaks at 46 MB and reads in 5.5s. Both loads must be streamed — the second one
    (`data_only=True`, for cached formula results) is the same size as the first.

    Read off the AST rather than the source text, because the text also contains this rule
    written out in prose — the first version of this test matched its own docstring. Measured
    rather than asserted is not an option here: the libraries are absent outside the image, and a
    memory assertion is exactly the kind that goes quietly green when it is skipped.
    `test_read_attachment.py` covers the OUTPUT; this covers the how.

    Mutation receipt: flip either `read_only=True` back to `False` and this goes red.
    """
    loads = [
        call
        for call in ast.walk(ast.parse(READER.read_text(encoding="utf-8")))
        if isinstance(call, ast.Call)
        and isinstance(call.func, ast.Attribute)
        and call.func.attr == "load_workbook"
    ]

    assert len(loads) == 2, f"expected two workbook loads, found {len(loads)}"
    for call in loads:
        streamed = [k.value for k in call.keywords if k.arg == "read_only"]
        assert streamed and all(
            isinstance(v, ast.Constant) and v.value is True for v in streamed
        ), (
            "both workbook loads must stream; a materialising load cannot read a 10 MB workbook "
            "inside MEMORY_LIMIT_BYTES"
        )


def test_the_merge_scan_does_not_build_a_tree() -> None:
    """★ THE MISTAKE THIS ALREADY MADE ONCE, pinned so it cannot come back.

    Merged ranges are not populated on a read-only worksheet, so they are read from the sheet part
    directly. The first attempt used `ET.iterparse` with `element.clear()` — which does NOT unlink
    the element from its parent, so the root accumulated every `<row>` and `<c>` in the sheet. On
    the dense workbook that put the reader at 527 MB and straight back over the ceiling, while the
    openpyxl half of the same read sat at 38 MB.

    Read off the AST for the same reason as the test above: the explanation names the very call
    it forbids.

    Mutation receipt: reintroduce `iterparse` in `_merged_ranges` and this goes red.
    """
    tree = ast.parse(READER.read_text(encoding="utf-8"))
    called = {
        node.func.attr
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    } | {
        node.func.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    }

    assert "iterparse" not in called
    assert "_MERGE_SCAN_CHUNK" in {
        target.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign)
        for target in node.targets
        if isinstance(target, ast.Name)
    }


def test_a_merge_ref_split_across_a_read_boundary_is_still_found() -> None:
    """The chunked scan keeps a tail so a tag straddling two reads is not lost — and the overlap
    must not double-count the tags it re-sees."""
    reader = _load_reader()
    ranges = reader._MERGE_CELL_REF.findall(
        b'<mergeCells count="2"><mergeCell ref="A1:B1"/><mergeCell ref=\'C3:D9\'/></mergeCells>'
    )

    assert [r.decode() for r in ranges] == ["A1:B1", "C3:D9"]


def test_a_cell_containing_merge_markup_cannot_forge_a_range() -> None:
    """A citizen who types a literal `<mergeCell` tag into a cell has it stored XML-escaped, so
    the bytes the scan matches cannot come from user data. Pinned because the scan reads bytes
    rather than parsing, and this is the assumption that makes that safe."""
    reader = _load_reader()
    escaped = b'<c r="A1" t="inlineStr"><is><t>&lt;mergeCell ref="Z1:Z9"/&gt;</t></is></c>'

    assert reader._MERGE_CELL_REF.findall(escaped) == []
