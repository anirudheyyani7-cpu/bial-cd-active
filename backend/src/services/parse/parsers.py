"""Kind dispatch for untrusted-file parsing, run inside the killable process governor.

Live kinds are the chat office→Markdown extracts (`extract_word`/`extract_excel`), driven by
`api/v1/attachments/router.py`; extraction itself lives in `services/extract/office.py`, and this
module orders the bounds around it and maps its errors. Four bounds: (1) decoded-size cap
enforced by the caller before parsing (the old per-app parse HTTP endpoint was retired with the
open-sandbox pivot, but this SERVICE stays); (2) zip-bomb guard runs here BEFORE any inflate, the
structural gate runs first inside extract — shared `zip_safety` + `office` validators; (3) a
row/col range-clamp applied BEFORE iterating, via `office.py`'s `MAX_SHEET_ROWS`/text cap; (4)
the whole dispatch runs inside `governor.py`. Errors are the shared `FileParseError` (e.g.
413/`FILE_TOO_LARGE`, 415/`UNSUPPORTED_TYPE`).
"""

from __future__ import annotations

from typing import Any

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


def parse_dispatch(buffer: bytes, kind: str, filename: str, sheet: str | None) -> dict[str, Any]:
    """Run the bounds then the extract for `kind`. Called INSIDE the killable governor child.

    The `extract_*` kinds are the whole live surface — the chat office→Markdown path, sharing
    this governor so an untrusted docx/xlsx inflate can never OOM the shared API worker. The
    `__test_*` kinds are test-only governor seams; the one live caller derives its kind from
    `office_format_for`, so it can pass neither those nor an unknown one. `sheet` is accepted
    for the governor's uniform call shape and is unused by the extract kinds."""
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

    raise FileParseError(
        "Supported: Word (.docx) and Excel (.xlsx).",
        status=415,
        code="UNSUPPORTED_TYPE",
    )
