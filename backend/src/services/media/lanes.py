"""Which of the two lanes a media type belongs to, and the admission checks for the second (#214).

THE ONE RULE THE WHOLE FEATURE RESTS ON. An attachment is routed by what can be DONE with it, not
by a list of extensions:

  * the MODEL lane — PNG, JPEG, GIF, WebP, PDF — the model reads the bytes itself. That is
    `magic.ALLOWED_MEDIA`, unchanged.
  * the CODE lane — Excel, Word, PowerPoint, CSV, TSV — code in the workspace reads the file and
    reports what it found. The model never receives the bytes.

WHY `ALLOWED_MEDIA` IS NOT WIDENED, which is the opposite of the obvious change. That set is the
magic-byte gate, and it is applied on BOTH paths that end at the model: the upload route
(`ALLOWED_MEDIA.get` + `magic_matches`) and the store's rehydrator (`bytes_match_declared`).
Adding OOXML there would make both answer True for a deck, and a spreadsheet would reach the model
as raw ZIP bytes: expensive, unreadable, and exactly the confident-wrong-answer failure this work
exists to remove.

(There was a third — the build session's own attachment resolver, which refused a deck by name.
It went with the whole legacy build-sessions attachment surface in #218. The count moves; the
reasoning does not, which is the point of routing by lane rather than by a list of types.)

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

# THE SUFFIX THE READER DISPATCHES ON — not a display detail (#214 R20a).
#
# `read_attachment.py` picks its reader from `path.suffix.lower()` and from nothing else, so the
# name a file is written under inside the container decides whether it can be read at all. Two
# admitted files would otherwise arrive unreadable: an `.xlsx` whose citizen-supplied name carries
# no extension (the OPC check reads the BYTES, and never looks at the name), and a `movements.tab`
# — a name the TSV door deliberately accepts because it is a real TSV convention, and a suffix the
# reader's table does not carry.
#
# So the media type, which was verified at the door, names the file. The citizen's own name is
# still what they are shown and what the agent is told; this is the on-disk spelling underneath it.
_SUFFIX_FOR: Final[dict[str, str]] = {
    WORD_MEDIA_TYPE: ".docx",
    EXCEL_MEDIA_TYPE: ".xlsx",
    PPTX_MEDIA_TYPE: ".pptx",
    CSV_MEDIA_TYPE: ".csv",
    TSV_MEDIA_TYPE: ".tsv",
}


def canonical_suffix(media_type: str) -> str:
    """The file extension a code-lane file must be written under, or `""` for anything else."""
    return _SUFFIX_FOR.get(media_type, "")


# An encrypted OOXML file is an OLE2 compound document, not a ZIP: Office wraps the whole encrypted
# package in one. The signature is fixed and eight bytes long, so a locked file is distinguishable
# from an ordinary one WITHOUT opening it — which is what makes refusing at the door possible.
_OLE2_SIGNATURE: Final = bytes([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])
_ZIP_SIGNATURE: Final = bytes([0x50, 0x4B, 0x03, 0x04])


def is_code_lane(media_type: str) -> bool:
    """Is this a file that CODE reads, rather than one the model reads itself?"""
    return media_type in CODE_LANE_MEDIA


def is_opc_archive(media_type: str) -> bool:
    """Is this a ZIP-based Office file, as opposed to a delimited text file?

    ★ THE CODE LANE IS NOT ALL ARCHIVES, and treating it as one refused every CSV and TSV at the
    door with "Malformed archive (no ZIP end-of-central-directory)" — which is a true statement
    about a file that was never supposed to be an archive, and unactionable advice to a citizen
    holding a perfectly good spreadsheet export.

    The zip-bomb bound belongs to the OOXML half alone: those are ZIPs and a 4 MB one can declare
    300 MB uncompressed. A `.csv` is bytes of text, bounded by the size cap like anything else,
    and has no central directory to check.
    """
    return media_type in _OPC_PART


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
