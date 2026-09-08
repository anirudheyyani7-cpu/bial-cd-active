"""Parse governor: the killable subprocess (timeout/OOM → 413) and the bounds
the dispatch runs around the chat office→Markdown extract — zip-bomb pre-filter, OPC
structural gate, and the refusal of kinds the dispatch does not serve.

The extraction itself is covered by `tests/services/extract/test_office.py`; what is pinned
here is that the governor contains it and that the bounds are wired in front of it."""

from __future__ import annotations

import io
import struct
import time
import zipfile

import openpyxl
import pytest
from pypdf import PasswordType, PdfReader

from src.services.extract.deck import count_pdf_pages as deck_byte_scan
from src.services.extract.zip_safety import FileParseError
from src.services.parse.governor import PARSE_TIMEOUT_S, run_parse
from src.services.parse.parsers import parse_dispatch
from tests.pdfs import (
    locked_pdf,
    objstm_pdf,
    ouroboros_pdf,
    pdf_bigger_on_the_inside,
    pdf_with_pages,
    restricted_pdf,
    unreadable_pdf,
    xref_bomb_pdf,
)


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


# --- the PDF page count -----------------------------------------------------
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
    """★ WHY THE PDF PAGE COUNT DOES NOT REUSE `extract/deck.py::count_pdf_pages`.

    Its raw-byte `/Type /Page` scan is reliable only for LibreOffice/Gotenberg output: modern
    producers write page objects into a COMPRESSED object stream instead, so no such bytes
    appear and the scan reports zero pages for a 31-page document — enough to wave it straight
    past a 30-page cap. Under-counting is the dangerous direction here, since it admits a
    document the window charge cannot honestly cover. Swap the new kind for the deck scan and
    this test goes red."""
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

    Eight kilobytes: a Flate-compressed cross-reference stream declaring two million entries, every
    one of which a reader must materialise before it can resolve the catalog. It sits inside the 4
    MB size cap and inside the memory ceiling, yet costs seven to twelve seconds — unbounded in the
    only axis neither bound watches. Given time the same bytes parse to a one-page document, so
    what stops this test passing for the wrong reason is the deadline, not a malformation; move the
    count into the request handler and there is no deadline to hit."""
    bomb = xref_bomb_pdf()

    with pytest.raises(FileParseError) as exc:
        await run_parse(bomb, "count_pdf_pages", "doc.pdf", None, timeout=1.0)
    assert exc.value.status == 413
    assert exc.value.code == "PARSE_TIMEOUT"

    # Control: it is a real, readable PDF — one page — not a file that would have failed anyway.
    assert parse_dispatch(bomb, "count_pdf_pages", "doc.pdf", None) == {"pageCount": 1}


# --- the count is walked, ENCRYPTED OR NOT (U28 / R12, R12a) ---------------------
#
# ★ THE 30-PAGE CAP WAS WALKABLE PAST BY ANY ENCRYPTED FILE (#194). `len(reader.pages)` reaches
# pypdf's `get_num_pages()`, which returns the catalog's DECLARED `/Count` unwalked whenever
# `is_encrypted` is set — and `is_encrypted` is `"/Encrypt" in trailer`, which stays true after
# a successful decryption, forever. So the shortcut was permanent, and since pypdf opens a
# permission-restricted document automatically (empty user password), the declaration was
# attacker-controlled. 120 KB bought twenty thousand pages behind a cap of thirty.


def test_an_encrypted_pdf_cannot_lie_its_way_under_the_cap() -> None:
    """★ THE BYPASS, AND THE CONTROL THAT PROVES IT WAS THE ENCRYPTION.

    Two files of the same shape — one page object listed in `/Kids` twenty thousand times, a
    catalog declaring one — differing only in whether an encryption dictionary is attached.
    Before U28 the plain one counted 20,000 and the encrypted one counted 1, which is the whole
    defect: not that PDFs were mis-counted, but that adding `/Encrypt` to a file switched the
    count from the tree to the attacker's own number. Both must now answer 20,000.

    Revert `_flatten` to `len(reader.pages)` and only the second assertion goes red — which is
    why the plain twin is asserted first and in the same test rather than trusted from a
    neighbour."""
    honest_walk = {"pageCount": 20_000}

    plain = pdf_bigger_on_the_inside(pages=20_000, declares=1)
    assert parse_dispatch(plain, "count_pdf_pages", "doc.pdf", None) == honest_walk

    encrypted = restricted_pdf(pages=20_000, declares=1)
    assert parse_dispatch(encrypted, "count_pdf_pages", "doc.pdf", None) == honest_walk


@pytest.mark.parametrize(
    ("owner", "verdict"),
    [("", PasswordType.OWNER_PASSWORD), ("ownerly", PasswordType.USER_PASSWORD)],
)
def test_an_encrypted_but_unlocked_pdf_is_read_not_refused(
    owner: str, verdict: PasswordType
) -> None:
    """★ ENCRYPTED IS NOT LOCKED, and the difference is not a truthiness check.

    A permission-restricted document — printing or copying disabled, USER password empty — is
    the ordinary encrypted PDF in an office, and pypdf opens it without being asked. Refusing
    on `is_encrypted`, or on any truthy reading of the encryption state, would refuse most of
    the encrypted PDFs a citizen owns.

    The discriminator asserted here is the one the reader actually answers: an empty password
    against `PasswordType`. It reports OWNER_PASSWORD when the owner password is empty too and
    USER_PASSWORD when it is not — two different non-zero values, either of which a `bool()`
    would flatten — and only `NOT_DECRYPTED` (0, the falsy one) means the file is locked."""
    document = restricted_pdf(pages=3, owner=owner)

    reader = PdfReader(io.BytesIO(document))
    assert reader.is_encrypted is True
    assert reader.decrypt("") == verdict

    assert parse_dispatch(document, "count_pdf_pages", "doc.pdf", None) == {"pageCount": 3}


def test_a_genuinely_locked_pdf_is_the_one_encrypted_file_that_is_refused() -> None:
    """The other side of the line above: an empty password leaves this one undecryptable, so
    nothing can be read out of it and the walk raises rather than guessing. It gets its OWN
    code, because "remove the password" is advice a citizen can act on and "too long" — for a
    three-page file — is not."""
    document = locked_pdf(pages=3)

    assert PdfReader(io.BytesIO(document)).decrypt("") == PasswordType.NOT_DECRYPTED

    with pytest.raises(FileParseError) as exc:
        parse_dispatch(document, "count_pdf_pages", "doc.pdf", None)
    assert exc.value.status == 400
    assert exc.value.code == "PDF_ENCRYPTED"


def test_a_page_tree_that_eats_its_own_tail_raises_instead_of_running_forever() -> None:
    """★ WHY THE WALK IS pypdf's OWN AND NOT A HAND-ROLLED ONE.

    Root `/Pages` → a second `/Pages` → root. There is no leaf anywhere in it, so a walk that
    tracks only "have I seen this object" by count, or that trusts `/Count` to bound itself,
    never returns. pypdf carries the ancestor path and raises; the dispatch maps that to the
    same 400 a truncated file gets, and the citizen is told nothing about page trees.

    Encrypted on purpose. Before U28 this file was never walked at all — the declared `/Count`
    of 1 was handed straight back — so a cycle only became reachable on the encrypted path when
    the count started being taken honestly, and this is the test that pays for it."""
    with pytest.raises(FileParseError) as exc:
        parse_dispatch(ouroboros_pdf(), "count_pdf_pages", "doc.pdf", None)
    assert exc.value.status == 400
    assert exc.value.code == "INVALID_PDF"


async def test_twenty_thousand_encrypted_pages_fit_inside_the_governors_budget() -> None:
    """The honest count is not bought with a timeout.

    Walking twenty thousand pages costs real time, and the alternative to walking them was a
    dictionary lookup — so "it is correct now" is only half the claim. Run through the REAL
    production deadline (10 s), in the spawned child, paying the spawn: the file that used to
    be admitted as one page is now counted as twenty thousand and refused, without ever
    reaching `PARSE_TIMEOUT`.

    The margin is asserted, not just the outcome. A walk that regressed to 9 s would still pass
    an assertion that only checked the answer, and would then fail in production on a machine
    slower than this one."""
    document = restricted_pdf(pages=20_000, declares=1)

    started = time.perf_counter()
    counted = await run_parse(document, "count_pdf_pages", "doc.pdf", None)
    elapsed = time.perf_counter() - started

    assert counted == {"pageCount": 20_000}
    assert elapsed < PARSE_TIMEOUT_S / 2, f"{elapsed:.2f}s of a {PARSE_TIMEOUT_S}s budget"
