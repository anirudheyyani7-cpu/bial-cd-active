#!/usr/bin/env python3
"""Report what an attached file CONTAINS, without sending the file to the model (#214).

WHY THIS SHIPS INSTEAD OF BEING WRITTEN EACH TURN. The platform used to flatten a workbook to
Markdown on the server, keep the first thousand rows, and say nothing about the rest — so a
question about a 5,000-row file was answered from a fifth of it, confidently and wrongly. Letting
an agent write a parser per turn reproduces that: our own from-scratch reader was wrong on its
first run, and five parsers given one crafted file disagreed on its row count by five orders of
magnitude. This is known-correct code the agent starts FROM.

ONE RETURN SHAPE, ALWAYS (R12a). Every run prints a single JSON object and exits 0 — a manifest
on success, a named failure on any other outcome. Never a stack trace, never a bare exception,
and never an empty manifest, because an empty manifest reads exactly like an empty file and that
is the class of wrong answer this whole design exists to remove.

IT STATES THE WHOLE WHENEVER IT SHOWS A PART (R17). Every truncated list carries the true count
beside it. Silence about what was omitted is the specific failure being replaced.

NO NETWORK. It opens one path on local disk and nothing else. The platform puts the file there
before the agent's first read; the reader never fetches, so its missing-file branch is a genuine
error rather than an expected path.

EDITING IT IS EXPECTED. The Build agent may read, change and re-run this file for something the
base version does not report. The canonical copy is kept outside the editable tree so a working
copy that has been broken can be restored.
"""

from __future__ import annotations

import json
import os
import signal
import sys

# BOUND THE PARALLELISM BEFORE polars IS IMPORTED, which is what makes the memory ceiling below
# mean anything. `RLIMIT_AS` counts VIRTUAL address space, and polars reserves a stack per worker
# thread up front: measured in the sandbox image, a 512 MB ceiling cannot even spawn its default
# pool — the process aborts with a thread-pool error before reading a byte, which reads as a
# broken container rather than a refused file. Two threads is ample for describing one file
# (200,000 rows well inside the limit) and keeps the reservation small enough that the ceiling
# bounds real usage instead of the allocator's bookkeeping.
#
# Set here rather than in `_apply_bounds` because polars reads it at IMPORT, and the import
# happens inside the reader function.
os.environ.setdefault("POLARS_MAX_THREADS", "2")
from pathlib import Path
from typing import Any

# The bounds. A read that cannot finish inside these is a NAMED FAILURE like any other, never a
# hang and never a container the platform has to notice is wedged. The server-side parser this
# replaces ran inside a killable, memory-capped subprocess; moving the parsing into the sandbox
# must not lose that, and neither `governor.py`'s rlimit nor its deadline reaches in here.
TIME_LIMIT_SECONDS = 30
# Sized against the platform's 4 MB per-file attachment cap with room for the object model a
# parser builds around it, which is several times the file on disk for a dense spreadsheet.
#
# BOUNDED WITH `RLIMIT_DATA`, NOT `RLIMIT_AS`, and the difference is the whole reason this is
# commented. `RLIMIT_AS` caps VIRTUAL address space, which for a Rust allocator with a worker
# pool is mostly reservation rather than memory in use: measured in this image, a 512 MB
# `RLIMIT_AS` aborts polars before it reads a byte, and the process dies with an allocator panic
# that reads as a broken container rather than a refused file. `RLIMIT_DATA` bounds the data the
# process actually asks for, so polars runs and a genuinely oversized read still raises
# `MemoryError` — verified both ways rather than assumed.
MEMORY_LIMIT_BYTES = 512 * 1024 * 1024

# How much of any unbounded list is shown. The true total always rides beside it (R17).
MAX_ITEMS = 50
MAX_SAMPLE_ROWS = 5
# Cell text is summarised, never dumped: this reports the SHAPE of a file so an app can be built
# to it, and a manifest that inlined every cell would be the flattening that was removed.
MAX_TEXT_CHARS = 300


class ReadFailure(Exception):
    """A failure the citizen can be told about, with something they can do next."""

    def __init__(self, code: str, message: str, next_step: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.next_step = next_step


def _clip(text: Any, limit: int = MAX_TEXT_CHARS) -> str:
    """One cell or paragraph, bounded, with the true length stated when it is cut (R17)."""
    s = "" if text is None else str(text)
    if len(s) <= limit:
        return s
    return f"{s[:limit]}… [{len(s)} characters total]"


def _listing(items: list[Any], limit: int = MAX_ITEMS) -> dict[str, Any]:
    """A bounded list that always reports the whole it came from."""
    return {"total": len(items), "shown": items[:limit]}


# --- spreadsheets -----------------------------------------------------------------------------


def read_xlsx(path: Path) -> dict[str, Any]:
    """Sheets, real dimensions, column types, formulas, merges and media.

    LOADED TWICE ON PURPOSE, and this is the requirement that costs the second load. openpyxl
    reads either the FORMULAS (`data_only=False`) or the values Excel last CACHED for them
    (`data_only=True`) — never both from one load. A workbook written by a script has never been
    opened by Excel, so its formula cells have no cached value at all: with only the value load
    those columns come back blank, and the citizen is shown an empty column for data that is
    simply uncalculated. Reading both is how the manifest can say "this column is a formula and
    carries no stored result" instead (R24).
    """
    import openpyxl
    from openpyxl.utils.exceptions import InvalidFileException

    try:
        formulas = openpyxl.load_workbook(path, data_only=False, read_only=False)
        values = openpyxl.load_workbook(path, data_only=True, read_only=False)
    except InvalidFileException as exc:
        raise ReadFailure(
            "unreadable",
            f"This file could not be opened as a spreadsheet ({exc}).",
            "Open it in Excel, re-save it as .xlsx, and attach it again.",
        ) from None

    sheets = []
    for name in formulas.sheetnames:
        fsheet, vsheet = formulas[name], values[name]
        rows, cols = fsheet.max_row or 0, fsheet.max_column or 0
        header = [
            _clip(c.value) for c in next(fsheet.iter_rows(min_row=1, max_row=1), ()) if c is not None
        ]

        columns = []
        for index in range(1, cols + 1):
            # The first data row is what the column's type is judged from — the header row is
            # text in almost every real file and would make every column look like a string.
            probe = fsheet.cell(row=2, column=index) if rows >= 2 else None
            cached = vsheet.cell(row=2, column=index) if rows >= 2 else None
            is_formula = isinstance(probe.value, str) and probe.value.startswith("=") if probe else False
            column: dict[str, Any] = {
                "name": header[index - 1] if index - 1 < len(header) else None,
                "isFormula": is_formula,
            }
            if is_formula:
                # THE R24 CASE. A formula with no cached value is not an empty column; saying so
                # is the whole point of the second load.
                column["hasStoredResult"] = cached is not None and cached.value is not None
                if not column["hasStoredResult"]:
                    column["note"] = (
                        "This column is a formula and the file carries no calculated result "
                        "for it — the workbook has not been opened by Excel since it was written."
                    )
            else:
                column["type"] = type(probe.value).__name__ if probe and probe.value is not None else None
            columns.append(column)

        sheets.append(
            {
                "name": name,
                "rows": rows,
                "columns": cols,
                "header": header,
                "columnDetail": _listing(columns),
                "mergedRanges": _listing([str(r) for r in fsheet.merged_cells.ranges]),
            }
        )

    formulas.close()
    values.close()
    return {"sheets": _listing(sheets), "media": _zip_media(path)}


def read_delimited(path: Path, separator: str) -> dict[str, Any]:
    """Columns, types, null and distinct counts, the true row count, and a few sample rows.

    polars rather than a hand-rolled split: typed columns, null and distinct counts and a lazy
    scan are exactly what let a file's shape be reported HONESTLY instead of guessed from its
    first rows — which is what the replaced extractor did.
    """
    import polars as pl

    try:
        lazy = pl.scan_csv(path, separator=separator, infer_schema_length=10_000)
        frame = lazy.collect()
    except Exception as exc:  # polars raises a family of parse errors; all mean the same thing here
        raise ReadFailure(
            "unreadable",
            f"This file could not be read as delimited text ({type(exc).__name__}).",
            "Check it opens in a spreadsheet program, re-save it, and attach it again.",
        ) from None

    columns = [
        {
            "name": name,
            "type": str(frame.schema[name]),
            "nulls": int(frame[name].null_count()),
            "distinct": int(frame[name].n_unique()),
        }
        for name in frame.columns
    ]
    sample = [
        {k: _clip(v) for k, v in row.items()} for row in frame.head(MAX_SAMPLE_ROWS).to_dicts()
    ]
    # `rows` is the TRUE height, not the sample's length — the number the old extractor never said.
    return {"rows": frame.height, "columns": _listing(columns), "sampleRows": sample}


# --- documents and decks ----------------------------------------------------------------------


def read_docx(path: Path) -> dict[str, Any]:
    """Paragraphs, headings, tables with their headers intact, and media NAMED not inlined.

    TWO OF THE THREE MEASURED DEFECTS LIVE HERE (R24). The replaced extractor inlined an embedded
    photo as text — 98.8% of one 66 KB report's 18,586 tokens were a picture the model could not
    see, and the 891 characters of actual prose were truncated to make room for it. And it
    flattened tables, losing the header row that says what the columns mean. So media is an
    inventory of names and sizes, and a table keeps its first row as `header`.
    """
    import docx  # python-docx

    try:
        document = docx.Document(str(path))
    except Exception as exc:
        raise ReadFailure(
            "unreadable",
            f"This file could not be opened as a Word document ({type(exc).__name__}).",
            "Open it in Word, re-save it as .docx, and attach it again.",
        ) from None

    paragraphs, headings = [], []
    for para in document.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        if (para.style.name or "").startswith("Heading"):
            headings.append({"level": para.style.name, "text": _clip(text)})
        paragraphs.append(_clip(text))

    tables = []
    for table in document.tables:
        rows = table.rows
        header = [_clip(c.text.strip()) for c in rows[0].cells] if rows else []
        body = [[_clip(c.text.strip()) for c in r.cells] for r in rows[1:]]
        tables.append(
            {
                "header": header,  # kept as a HEADER, not folded into the body (R24)
                "rows": len(body),
                "columns": len(header),
                "sampleRows": body[:MAX_SAMPLE_ROWS],
            }
        )

    return {
        "paragraphs": _listing(paragraphs),
        "headings": _listing(headings),
        "tables": _listing(tables),
        "media": _zip_media(path),
    }


def read_pptx(path: Path) -> dict[str, Any]:
    """Slide text in order, speaker notes, tables and chart data.

    THE VISUAL DESIGN IS NOT REPORTED, and that is a stated scope boundary rather than a gap: a
    deck cannot be rendered without a converter the platform is not allowed to host. A citizen who
    needs the model to SEE a slide is told to export the deck to PDF, which lands it in the lane
    the model can read directly.
    """
    import pptx  # python-pptx

    try:
        deck = pptx.Presentation(str(path))
    except Exception as exc:
        raise ReadFailure(
            "unreadable",
            f"This file could not be opened as a PowerPoint deck ({type(exc).__name__}).",
            "Open it in PowerPoint, re-save it as .pptx, and attach it again.",
        ) from None

    slides = []
    for number, slide in enumerate(deck.slides, start=1):
        text, tables, charts = [], [], []
        for shape in slide.shapes:
            if shape.has_text_frame and shape.text_frame.text.strip():
                text.append(_clip(shape.text_frame.text.strip()))
            if getattr(shape, "has_table", False):
                rows = shape.table.rows
                header = [_clip(c.text.strip()) for c in rows[0].cells] if len(rows) else []
                tables.append({"header": header, "rows": max(0, len(rows) - 1)})
            if getattr(shape, "has_chart", False):
                plots = shape.chart.plots
                categories = list(plots[0].categories) if len(plots) else []
                charts.append(
                    {
                        "type": str(shape.chart.chart_type),
                        "categories": _listing([_clip(c) for c in categories]),
                        "series": _listing(
                            [
                                {"name": s.name, "values": _listing([v for v in s.values])}
                                for s in shape.chart.series
                            ]
                        ),
                    }
                )

        notes = ""
        if slide.has_notes_slide and slide.notes_slide.notes_text_frame is not None:
            notes = _clip(slide.notes_slide.notes_text_frame.text.strip())

        slides.append(
            {"number": number, "text": _listing(text), "notes": notes,
             "tables": _listing(tables), "charts": _listing(charts)}
        )

    return {"slides": _listing(slides), "media": _zip_media(path)}


# --- shared -----------------------------------------------------------------------------------


def _zip_media(path: Path) -> dict[str, Any]:
    """What images and other media the file carries — NAMED AND SIZED, never inlined.

    This is the defect that cost the most: an embedded photo rendered as text is bytes the model
    cannot see, charged at full price, crowding out the words that mattered. An inventory tells
    the agent a picture exists without spending the context to not-look at it.

    Every Office format is a ZIP, so one implementation covers all three.
    """
    import zipfile

    try:
        with zipfile.ZipFile(path) as archive:
            media = [
                {"name": info.filename.split("/")[-1], "bytes": info.file_size}
                for info in archive.infolist()
                if "/media/" in info.filename
            ]
    except (zipfile.BadZipFile, OSError):
        # Not fatal: the caller already parsed the file, so a media inventory that cannot be read
        # is missing detail rather than a failed read.
        return {"total": 0, "shown": [], "note": "The media inventory could not be read."}
    return _listing(media)


READERS = {
    ".xlsx": read_xlsx,
    ".docx": read_docx,
    ".pptx": read_pptx,
    ".csv": lambda p: read_delimited(p, ","),
    ".tsv": lambda p: read_delimited(p, "\t"),
}


def _apply_bounds() -> None:
    """Wall clock and address space, so a hostile or pathological file cannot wedge the container.

    Both raise into the same named-failure path as any other error — a killed read is reported,
    not silent. `resource` is Linux-only, which is what the sandbox runs; the guard is skipped
    where it is unavailable so the script stays runnable for development on other platforms.
    """

    def _out_of_time(_signum: int, _frame: Any) -> None:
        raise ReadFailure(
            "timeout",
            f"Reading this file took longer than {TIME_LIMIT_SECONDS} seconds.",
            "Attach a smaller file, or one with fewer sheets or rows.",
        )

    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, _out_of_time)
        signal.alarm(TIME_LIMIT_SECONDS)
    try:
        import resource

        resource.setrlimit(resource.RLIMIT_DATA, (MEMORY_LIMIT_BYTES, MEMORY_LIMIT_BYTES))
    except (ImportError, ValueError, OSError):
        pass


def describe(path: Path) -> dict[str, Any]:
    """The manifest for one file, or a raised `ReadFailure` naming what went wrong."""
    if not path.exists():
        # A GENUINE ERROR, not an expected path: the platform restores the file from the stored
        # original before the agent's first read, so the reader only ever meets a present file.
        raise ReadFailure(
            "missing",
            f"There is no file at {path}.",
            "Ask for the file to be restored, or attach it again.",
        )
    reader = READERS.get(path.suffix.lower())
    if reader is None:
        raise ReadFailure(
            "unsupported",
            f"{path.suffix or 'This file type'} is not one this reader handles.",
            "Attach a spreadsheet (.xlsx), document (.docx), deck (.pptx), .csv or .tsv.",
        )
    try:
        body = reader(path)
    except ReadFailure:
        raise
    except MemoryError:
        raise ReadFailure(
            "too_large",
            "This file needs more memory to read than the workspace allows.",
            "Attach a smaller file, or split it.",
        ) from None
    except Exception as exc:
        # ENCRYPTION LANDS HERE, among other things. Every library refuses a password-protected
        # file in its own way, so the shape is named rather than the exception type guessed at.
        hint = "encrypted" if "encrypt" in str(exc).lower() or "password" in str(exc).lower() else "unreadable"
        raise ReadFailure(
            hint,
            f"This file could not be read ({type(exc).__name__}).",
            "Remove the password and attach it again."
            if hint == "encrypted"
            else "Re-save the file in its own application and attach it again.",
        ) from None
    return {"ok": True, "file": path.name, "kind": path.suffix.lower().lstrip("."), **body}


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print(json.dumps({"ok": False, "error": {"code": "usage",
                                                 "message": "Give the reader exactly one file path.",
                                                 "next": f"Run: python3 {argv[0]} <path>"}}))
        return 0
    _apply_bounds()
    path = Path(argv[1])
    try:
        result = describe(path)
    except ReadFailure as failure:
        # EXIT 0 WITH A NAMED FAILURE, deliberately. A non-zero exit is read as "the command
        # broke" and invites a retry or a hand-written parser; a JSON failure is an answer the
        # agent can pass to the citizen as a sentence.
        result = {
            "ok": False,
            "file": path.name,
            "error": {"code": failure.code, "message": failure.message, "next": failure.next_step},
        }
    finally:
        if hasattr(signal, "SIGALRM"):
            signal.alarm(0)
    print(json.dumps(result, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
