"""Kind dispatch for untrusted-file parsing, run inside the killable process governor.

Live kinds: chat office→Markdown extracts (`extract_word`/`extract_excel`) and PDF page count
(`count_pdf_pages`), driven by `api/v1/attachments/router.py`; extraction lives in
`services/extract/office.py`; this module orders the bounds and maps errors. Four bounds: (1)
decoded-size cap enforced by the caller before parsing (the old per-app parse endpoint was retired
with the open-sandbox pivot, but this SERVICE stays); (2) zip-bomb guard runs here BEFORE any
inflate, the structural gate runs first inside extract — shared `zip_safety` + `office` validators;
(3) row/col clamp applied BEFORE iterating, via `office.py`'s `MAX_SHEET_ROWS`/text cap; (4) the
dispatch runs inside `governor.py`. Errors are the shared `FileParseError`, which carries a status
and a code (413/`FILE_TOO_LARGE`, 415/`UNSUPPORTED_TYPE`).
"""

from __future__ import annotations

import io
from typing import Any, Final

from src.services.extract.office import (
    EXCEL_MEDIA_TYPE,
    WORD_MEDIA_TYPE,
    OfficeExtractError,
    extract_office,
)
from src.services.extract.zip_safety import FileParseError, assert_zip_not_bomb


def _extract_office_payload(buffer: bytes, media_type: str, filename: str) -> dict[str, Any]:
    """Chat office-extract → Markdown (the `ExtractResult` shape as a JSON-safe dict).
    Runs INSIDE the governor child so an inflate bomb is bounded by the child's rlimit."""
    try:
        result = extract_office(buffer, media_type, name=filename)
    except OfficeExtractError as exc:
        raise FileParseError(str(exc), status=400, code="INVALID_OFFICE_FILE") from exc
    return {
        "format": result.format,
        "text": result.text,
        "truncated": result.truncated,
        "truncationNote": result.truncation_note,
    }


PDF_UNREADABLE_CODE: Final = "INVALID_PDF"
"""What a PDF that will not parse is reported as. A 400, not the governor's generic 500
`PARSE_FAILED`: a malformed upload is the caller's file, not the platform failing."""

PDF_ENCRYPTED_CODE: Final = "PDF_ENCRYPTED"
"""A PDF that parsed far enough to say it is locked. Distinct from `INVALID_PDF` because it is
the one PDF failure the citizen can act on — every other one is a fact about the platform, and
those stay collapsed behind a single sentence on purpose."""


def _count_pdf_pages_payload(buffer: bytes) -> dict[str, Any]:
    """A real PDF's page count, read by a real PDF reader. Runs INSIDE the governor child.

    ★ THIS IS NOT `extract/deck.py::count_pdf_pages`, AND MUST NOT BECOME IT. That one scans
    the raw bytes for `/Type /Page` markers, which is documented as reliable for the
    LibreOffice/Gotenberg output it was written for and silently UNDER-counts any PDF whose
    page objects live in a compressed object stream — the one failure mode an admission cap
    cannot have, because under-counting is what admits the document the charge cannot cover.
    The deck path keeps its scan and its own 100-page limit; the two caps disagreeing is
    deliberate and is revisited when decks are enabled.

    ★ THE PAGE TREE IS WALKED, AND `len(reader.pages)` DOES NOT WALK IT FOR AN ENCRYPTED FILE.
    This line used to read `len(reader.pages)` and this docblock used to claim the count was
    therefore honest. That was true of an unencrypted file and false of every encrypted one:
    `get_num_pages()` short-circuits to `root_object["/Pages"]["/Count"]` — the catalog's own
    DECLARATION — whenever `is_encrypted` is set, and `is_encrypted` is nothing but
    `"/Encrypt" in trailer`, which stays true forever, including after a successful
    decryption. So the shortcut was permanent for encrypted files, and since pypdf opens a
    permission-restricted document automatically (empty user password), 120 KB declaring one
    page and carrying twenty thousand was counted as one and admitted straight past the
    30-page cap. `_flatten` is the traversal the unencrypted path already took, so the fix is
    to stop asking the question that has a wrong answer rather than to hand-roll a second walk
    beside the library's — a home-grown one has to reproduce pypdf's ancestor-path cycle guard
    exactly or hang forever on a leaf-less loop. `list_only=True` skips materialising each
    page's inherited attributes; nothing here reads a page.

    pypdf's own traversal limits (depth, entry count) turn a page-tree bomb into an exception
    here rather than a hang, and everything it can still raise — a truncated file, a broken
    cross-reference, a page tree that eats its own tail, a recursion limit — is mapped to one
    400. `MemoryError` is deliberately re-raised: the governor maps it to its own 413, and
    swallowing it would report a contained OOM as a malformed file.

    ENCRYPTION IS NOT A REFUSAL HERE and must never become one. pypdf attempts an empty
    password on construction, so a permission-restricted or owner-password-only document opens
    and is counted like any other file; only a genuinely password-locked one — where an empty
    password leaves the document undecryptable — reaches the `FileNotDecryptedError` arm."""
    # Imported HERE, not at module scope: `spawn` re-imports this module in every governor
    # child, so a top-level pypdf import would be paid by the office kinds too — and by the
    # API process at boot, which never counts a page.
    from pypdf import PdfReader
    from pypdf.errors import FileNotDecryptedError

    try:
        reader = PdfReader(io.BytesIO(buffer))
        # Private, and deliberately so: it is the only entry point to pypdf's traversal that
        # the encrypted short-circuit does not stand in front of. `len(reader.pages)` is the
        # bug this closes, and `list(reader.pages)` is the same bug wearing a hat — the
        # virtual list's own iterator is `range(len(self))`, so it yields the declared count
        # too. See the docblock.
        reader._flatten(list_only=True)
        walked = reader.flattened_pages
        if walked is None:
            # Unreachable — the top-level call assigns `[]` before it descends — and written
            # out rather than defaulted to zero because a walk that did not happen has to
            # REFUSE the file. Under-counting is the one direction an admission cap cannot
            # take; this falls into the broad arm below as one more 400.
            raise ValueError("the page tree was not walked")
        pages = len(walked)
    except MemoryError:
        raise
    except FileNotDecryptedError as exc:
        # A LOCKED DOCUMENT IS NOT A BROKEN ONE, and it is the one failure here the citizen can
        # actually do something about. Every other arm below is a fact about the platform (a
        # malformation, a bomb, a timeout) and is deliberately collapsed into one sentence; this
        # is a fact about THEIR file, so it gets its own code and the caller gives it its own
        # advice. Folding it in with the rest would tell someone holding a three-page locked
        # invoice that it is too long — advice that cannot be followed, which is the exact shape
        # `attachmentInput.ts` records as "advice is only honest while it leads somewhere".
        raise FileParseError(
            "The file is password-protected.", status=400, code=PDF_ENCRYPTED_CODE
        ) from exc
    except Exception as exc:
        # Broad on purpose: a hostile file reaches pypdf through a dozen call paths and the
        # library raises whatever the malformation happens to hit (`PdfReadError`, `KeyError`,
        # `RecursionError`, `struct.error`, `zlib.error`). An allowlist of exception types
        # here would let one unlisted shape through as the governor's generic 500.
        raise FileParseError(
            "The file could not be read as a PDF.", status=400, code=PDF_UNREADABLE_CODE
        ) from exc
    return {"pageCount": pages}


def parse_dispatch(buffer: bytes, kind: str, filename: str, sheet: str | None) -> dict[str, Any]:
    """Run the bounds then the extract for `kind`. Called INSIDE the killable governor child.

    The `extract_*` and `count_pdf_pages` kinds are the whole live surface — the chat
    office→Markdown path and the PDF upload page cap — sharing this governor so neither an
    untrusted docx/xlsx inflate nor a hostile PDF can OOM or stall the shared API worker. The
    `__test_*` kinds are test-only governor seams; the live callers pass a kind derived from
    the upload's own media type, so they can pass neither those nor an unknown one. `sheet` is
    accepted for the governor's uniform call shape and is unused by every live kind."""
    if kind == "__test_sleep":  # governor timeout seam
        import time

        time.sleep(30)
        return {}
    if kind == "__test_crash":  # governor hard-kill seam (simulates an OOM-kill)
        import os

        os._exit(137)
    if kind == "__test_oom":  # governor memory-ceiling seam
        _ = bytearray(4 * 1024 * 1024 * 1024)
        return {}

    if kind == "extract_word":  # chat docx → Markdown, zip-bomb-bounded in the governor
        assert_zip_not_bomb(buffer)
        return _extract_office_payload(buffer, WORD_MEDIA_TYPE, filename)
    if kind == "extract_excel":  # chat xlsx → Markdown, zip-bomb-bounded in the governor
        assert_zip_not_bomb(buffer)
        return _extract_office_payload(buffer, EXCEL_MEDIA_TYPE, filename)
    if kind == "count_pdf_pages":  # PDF upload page cap, time- and memory-bounded in the governor
        return _count_pdf_pages_payload(buffer)

    raise FileParseError(
        "Supported: Word (.docx), Excel (.xlsx) and PDF.",
        status=415,
        code="UNSUPPORTED_TYPE",
    )
