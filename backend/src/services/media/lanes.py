"""Which of the two lanes a media type belongs to, and the admission checks for the second (#214).

THE ONE RULE THE WHOLE FEATURE RESTS ON. An attachment is routed by what can be DONE with it, not
by a list of extensions:

  * the MODEL lane — PNG, JPEG, GIF, WebP, PDF — the model reads the bytes itself. That is
    `magic.ALLOWED_MEDIA`, unchanged.
  * the CODE lane — Excel, Word, PowerPoint, CSV, TSV — code in the workspace reads the file and
    reports what it found. The model never receives the bytes.

WHY `ALLOWED_MEDIA` IS NOT WIDENED, which is the opposite of the obvious change. That set is the
magic-byte gate, and `bytes_match_declared` is applied on THREE paths that all end at the model:
the upload route, the store's rehydrator, and `build_sessions/attachments.py`. Adding OOXML there
would make `bytes_match_declared` answer True for a deck at every one of them — and the PowerPoint
refusal that used to stop a deck reaching a build's `BinaryContent` would then be the only thing in
the way, on a path where it is easy to delete as obsolete. A spreadsheet would reach the model as
raw ZIP bytes: expensive, unreadable, and exactly the confident-wrong-answer failure this work
exists to remove.

So the second lane is its own set, admitted only where an attachment is STORED. The three
model-facing consumers keep the narrow gate they already had, and they refuse the code lane without
a single line changing in any of them. The separation is structural rather than remembered.

PASSWORD PROTECTION IS DETECTED AT THE DOOR, for every format that can carry it (R6). An encrypted
Office file is not a damaged ZIP — it is an OLE2 compound document wrapping the encrypted package,
and it announces itself in its first eight bytes. So a locked workbook is refused with the same
sentence a locked PDF gets, rather than being accepted, stored, charged, and failing inside the
sandbox several turns later where nothing can explain it.
"""

from __future__ import annotations

from typing import Final

WORD_MEDIA_TYPE: Final = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
EXCEL_MEDIA_TYPE: Final = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
PPTX_MEDIA_TYPE: Final = (
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
)
CSV_MEDIA_TYPE: Final = "text/csv"
TSV_MEDIA_TYPE: Final = "text/tab-separated-values"

# The OPC part each OOXML format must carry. All three share the ZIP signature, so the part name is
# the only discriminator there is — without it a `.pptx` and a plain `.zip` are the same bytes, and
# a renamed archive would be admitted as a deck.
_OPC_PART: Final[dict[str, bytes]] = {
    WORD_MEDIA_TYPE: b"word/document.xml",
    EXCEL_MEDIA_TYPE: b"xl/workbook.xml",
    PPTX_MEDIA_TYPE: b"ppt/presentation.xml",
}

# CSV and TSV have NO magic bytes — any text is a valid CSV, which is the whole point of the format
# — so they are admitted on their declared type and extension. That is not a weaker check than the
# others; it is the only check that exists for them, and pretending otherwise would mean inventing
# a signature and refusing real files that do not match it.
_DELIMITED: Final[dict[str, tuple[str, ...]]] = {
    CSV_MEDIA_TYPE: (".csv",),
    TSV_MEDIA_TYPE: (".tsv", ".tab"),
}

CODE_LANE_MEDIA: Final[frozenset[str]] = frozenset(_OPC_PART) | frozenset(_DELIMITED)

# An encrypted OOXML file is an OLE2 compound document, not a ZIP: Office wraps the whole encrypted
# package in one. The signature is fixed and eight bytes long, so a locked file is distinguishable
# from an ordinary one WITHOUT opening it — which is what makes refusing at the door possible.
_OLE2_SIGNATURE: Final = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
_ZIP_SIGNATURE: Final = bytes([0x50, 0x4B, 0x03, 0x04])


def is_code_lane(media_type: str) -> bool:
    """Is this a file that CODE reads, rather than one the model reads itself?"""
    return media_type in CODE_LANE_MEDIA


def looks_password_protected(data: bytes) -> bool:
    """Is this an encrypted Office file? True for the OLE2 wrapper Office writes for one."""
    return data[:8] == _OLE2_SIGNATURE


def code_lane_refusal(media_type: str, name: str, data: bytes) -> str | None:
    """Why this code-lane upload is refused, or None if it may be stored.

    ORDERED SO THE CITIZEN GETS THE MOST ACTIONABLE SENTENCE. Password protection is checked before
    structure, because an encrypted file is also a structurally invalid ZIP — and "remove the
    password" is something a person can do, while "this file is damaged" about a file they know is
    fine reads as the platform being broken.
    """
    if media_type in _DELIMITED:
        suffixes = _DELIMITED[media_type]
        if not name.lower().endswith(suffixes):
            return (
                f'"{name}" does not look like a {suffixes[0]} file. '
                f"Rename it with a {suffixes[0]} extension and attach it again."
            )
        return None

    part = _OPC_PART.get(media_type)
    if part is None:
        return f"Unsupported attachment type: {media_type}."
    if looks_password_protected(data):
        return "That file is password-protected. Remove the password and attach it again."
    if data[:4] != _ZIP_SIGNATURE:
        return f'"{name}" could not be read as an Office file. Re-save it and attach it again.'
    if part not in data:
        # The OPC part is stored uncompressed in the ZIP's own headers, so a plain substring search
        # over the bytes is enough to tell the three formats apart without unpacking anything.
        return (
            f'"{name}" does not match the file type it was sent as. '
            "Re-save it in its own application and attach it again."
        )
    return None
