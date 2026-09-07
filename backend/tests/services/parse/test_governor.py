"""Parse governor: the killable subprocess (timeout/OOM → 413) and the bounds
the dispatch runs around the chat office→Markdown extract — zip-bomb pre-filter, OPC
structural gate, and the refusal of kinds the dispatch does not serve.

The extraction itself is covered by `tests/services/extract/test_office.py`; what is pinned
here is that the governor contains it and that the bounds are wired in front of it."""

from __future__ import annotations

import io
import struct
import zipfile

import openpyxl
import pytest

from src.services.extract.deck import count_pdf_pages as deck_byte_scan
from src.services.extract.zip_safety import FileParseError
from src.services.parse.governor import run_parse
from src.services.parse.parsers import parse_dispatch
from tests.pdfs import objstm_pdf, pdf_with_pages, unreadable_pdf, xref_bomb_pdf


def _xlsx(rows: list[list[object]]) -> bytes:
    wb = openpyxl.Workbook()
    ws = wb.active
    assert ws is not None
    for row in rows:
        ws.append(row)
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


def _lying_zip(entries: dict[str, bytes], declared_uncompressed: int) -> bytes:
    """A real archive whose central directory DECLARES `declared_uncompressed` bytes.

    The pre-filter sums the declared sizes and never inflates to check, precisely because
    they are attacker-controllable — so an overstated size is the threat, not a cheat.
    """
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in entries.items():
            archive.writestr(name, data)
    raw = buffer.getvalue()
    cdh = raw.index(b"\x50\x4b\x01\x02")  # PK\x01\x02 — first central-directory header
    return raw[: cdh + 24] + struct.pack("<I", declared_uncompressed) + raw[cdh + 28 :]


# --- dispatch bounds (in-process) ---------------------------------------------


@pytest.mark.parametrize("kind", ["xlsx", "xls", "csv", "word", "pdf"])
def test_retired_and_unknown_kinds_are_415(kind: str) -> None:
    # The structured-row kinds went with the per-app parse endpoint. The dispatch must
    # REFUSE them, not fall through to something that half-works: re-adding a branch for any
    # of them turns this red rather than quietly reviving a surface with no consumer.
    with pytest.raises(FileParseError) as exc:
        parse_dispatch(b"data", kind, "x.bin", None)
    assert exc.value.status == 415
    assert exc.value.code == "UNSUPPORTED_TYPE"


def test_non_office_bytes_rejected_by_the_structure_gate() -> None:
    # Under the EOCD minimum, so the zip pre-filter no-ops and the OPC structural gate is
    # what refuses this. Status and code pin the dispatch's `OfficeExtractError` → clean-400
    # mapping (without it the governor would report a generic 500); the message pins that the
    # GATE refused it, not mammoth choking downstream — which is the same 400 and the same
    # code, so without this line the test passes with the gate deleted.
    with pytest.raises(FileParseError, match="missing ZIP signature") as exc:
        parse_dispatch(b"not a zip at all", "extract_word", "x.docx", None)
    assert exc.value.status == 400
    assert exc.value.code == "INVALID_OFFICE_FILE"


def test_zip_bomb_refused_before_the_extract() -> None:
    # The entry is the one the excel structural gate looks for, so if the pre-filter were
    # dropped this file would reach openpyxl and fail as a 400 — never as a 413.
    bomb = _lying_zip({"xl/workbook.xml": b"<workbook/>"}, 400 * 1024 * 1024)
    with pytest.raises(FileParseError) as exc:
        parse_dispatch(bomb, "extract_excel", "x.xlsx", None)
    assert exc.value.status == 413
    assert exc.value.code == "FILE_TOO_LARGE"


# --- governor (killable subprocess) --------------------------------------------


async def test_governor_parses_in_subprocess() -> None:
    # The live chat path: openpyxl runs in the spawned child and the Markdown payload
    # crosses the Queue intact.
    data = _xlsx([["Name"], ["Alice"]])
    result = await run_parse(data, "extract_excel", "x.xlsx", None)
    assert result["format"] == "excel"
    assert "Alice" in result["text"]
    assert result["truncated"] is False


async def test_governor_timeout_is_413() -> None:
    with pytest.raises(FileParseError) as exc:
        await run_parse(b"", "__test_sleep", "", None, timeout=1.0)
    assert exc.value.status == 413
    assert exc.value.code == "PARSE_TIMEOUT"


async def test_governor_contained_crash_is_413() -> None:
    # A hard OS-level kill (simulated OOM) is contained → 413, never a server crash.
    with pytest.raises(FileParseError) as exc:
        await run_parse(b"", "__test_crash", "", None, timeout=3.0)
    assert exc.value.status == 413
    assert exc.value.code == "FILE_TOO_LARGE"


# --- the PDF page count (U6 / D4) ----------------------------------------------
#
# A fourth kind rides the same governor, for the same reason the office extracts do: a PDF is
# the worst-behaved thing the upload route accepts, and the two bounds that already exist —
# 4 MB of bytes and a magic prefix — do not bound what reading one costs.


def test_the_pdf_kind_counts_pages() -> None:
    assert parse_dispatch(pdf_with_pages(7), "count_pdf_pages", "doc.pdf", None) == {
        "pageCount": 7
    }


def test_an_unreadable_pdf_is_a_clean_400_not_a_governor_500() -> None:
    # Magic-valid, structurally absent. Without the dispatch's own mapping this escapes as a
    # bare exception and the governor reports the platform's generic 500 `PARSE_FAILED` for
    # what is plainly the caller's malformed file.
    with pytest.raises(FileParseError) as exc:
        parse_dispatch(unreadable_pdf(), "count_pdf_pages", "doc.pdf", None)
    assert exc.value.status == 400
    assert exc.value.code == "INVALID_PDF"


def test_the_deck_byte_scan_would_have_under_counted_this_document() -> None:
    """★ WHY D4 REFUSED TO REUSE `extract/deck.py::count_pdf_pages`.

    Its raw-byte `/Type /Page` scan is documented as reliable for LibreOffice/Gotenberg output.
    Every modern producer writes page objects into a COMPRESSED object stream instead, where
    no such bytes appear anywhere in the file — so the scan reports zero pages for a 31-page
    document and would wave it straight past a 30-page cap.

    Under-counting is the only direction that matters here: it admits the document the window
    charge cannot honestly cover, which is the whole of #194. Swap the new kind for the deck
    scan and this test is what goes red."""
    document = objstm_pdf(31)

    assert deck_byte_scan(document) == 0
    assert parse_dispatch(document, "count_pdf_pages", "doc.pdf", None) == {"pageCount": 31}


async def test_the_pdf_count_runs_in_the_subprocess() -> None:
    # The live upload path: pypdf runs in the spawned child and only an integer crosses back.
    assert await run_parse(pdf_with_pages(3), "count_pdf_pages", "doc.pdf", None) == {
        "pageCount": 3
    }


async def test_a_cross_reference_bomb_is_killed_at_the_deadline() -> None:
    """★ THE FILE THE GOVERNOR EXISTS FOR, in the PDF kind's own shape.

    Eight kilobytes: a Flate-compressed cross-reference stream declaring two million entries,
    every one of which a reader must materialise before it can resolve the catalog. It is
    inside the 4 MB size cap and inside the memory ceiling, and it costs seven to twelve
    seconds — unbounded in the only axis neither bound watches.

    The control below is what stops this passing for the wrong reason: given time, the same
    bytes parse to a one-page document, so the deadline is what refused it and not a
    malformation. Move the count into the request handler and there is no deadline to hit."""
    bomb = xref_bomb_pdf()

    with pytest.raises(FileParseError) as exc:
        await run_parse(bomb, "count_pdf_pages", "doc.pdf", None, timeout=1.0)
    assert exc.value.status == 413
    assert exc.value.code == "PARSE_TIMEOUT"

    # Control: it is a real, readable PDF — one page — not a file that would have failed anyway.
    assert parse_dispatch(bomb, "count_pdf_pages", "doc.pdf", None) == {"pageCount": 1}
