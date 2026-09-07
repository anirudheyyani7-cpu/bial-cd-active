"""Hand-rolled PDF fixtures for the upload page-cap admission (U6/D4).

WRITTEN BY HAND, NOT BY `pypdf`, AND THAT IS THE POINT. The thing under test is a `pypdf`
page count; building the fixture with the same library would only prove that pypdf agrees
with itself, and a bug in how the reader is driven would be invisible. These emit raw PDF
syntax — a classic cross-reference table, a catalog, a page-tree node and N page objects —
so the byte-level page count is a fact of the fixture rather than of the reader.

They are generated rather than committed because a 31-page binary in the tree is a blob
nobody can review, and the hostile one is 8 KB of syntax whose whole meaning is what it
does to a parser.
"""

from __future__ import annotations

import zlib

_HEADER = b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
"""Magic + the binary comment. The upload route's existing check reads the first 18 bytes,
so every fixture here passes it — which is the precondition for the page cap to matter."""


def _assemble(objects: list[bytes]) -> bytes:
    """`objects[i]` is the body of object `i + 1`; object 1 is the catalog. Emits the
    classic `xref` table + trailer that a conforming reader needs."""
    out = bytearray(_HEADER)
    offsets: list[int] = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number
        out += body
        out += b"\nendobj\n"
    xref_at = len(out)
    size = len(objects) + 1
    out += b"xref\n0 %d\n" % size
    out += b"0000000000 65535 f \n"
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (size, xref_at)
    return bytes(out)


def pdf_with_pages(pages: int) -> bytes:
    """An ordinary, valid PDF with exactly `pages` page objects (~100 bytes a page)."""
    kids = b" ".join(b"%d 0 R" % (index + 3) for index in range(pages))
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, pages),
    ]
    objects += [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"] * pages
    return _assemble(objects)


def unreadable_pdf() -> bytes:
    """Magic-valid bytes with no object structure at all — the file that passes the
    18-byte prefix check and then fails to parse. The shape a truncated upload takes."""
    return _HEADER + b"this file claims to be a PDF and is not\n"


def xref_bomb_pdf(entries: int = 8_000_000) -> bytes:
    """A tiny PDF that costs a reader seconds per kilobyte: a Flate-compressed cross-reference
    STREAM declaring `entries` entries, whose payload is a few kilobytes of zeros.

    The document itself is one blank page. What is hostile is the index: the reader must walk
    every declared entry before it can resolve the catalog. The cost is LINEAR IN `entries` and
    FLAT IN MEMORY — the entries decode as free objects, so nothing is retained — which is what
    makes it the right fixture here rather than an inflate bomb: the memory ceiling cannot catch
    it, and `entries` is the only thing that has to change to buy a minute instead of a second.
    At the default it is ~32 KB of upload for ~6 seconds of parsing: inside the 4 MB size cap,
    inside the memory ceiling, unbounded in the only axis neither of them watches.

    It is the file the governor exists for: read in-process it blocks the event loop serving
    every other citizen; read in the governor it is killed and the request answers.
    """
    out = bytearray(_HEADER)

    def add(number: int, body: bytes) -> None:
        out.extend(b"%d 0 obj\n" % number)
        out.extend(body)
        out.extend(b"\nendobj\n")

    add(1, b"<< /Type /Catalog /Pages 2 0 R >>")
    add(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>")
    add(3, b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>")
    payload = zlib.compress(bytes(entries * 4), 9)
    xref_at = len(out)
    out.extend(
        b"4 0 obj\n<< /Type /XRef /Size %d /Index [0 %d] /W [1 2 1] /Root 1 0 R"
        b" /Filter /FlateDecode /Length %d >>\nstream\n" % (entries, entries, len(payload))
    )
    out.extend(payload)
    out.extend(b"\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n" % xref_at)
    return bytes(out)


def objstm_pdf(pages: int) -> bytes:
    """A valid PDF whose catalog, page-tree node and page objects all live in a COMPRESSED
    object stream, reached through a cross-reference STREAM (PDF 1.5, and what every modern
    producer emits).

    This is the fixture behind D4's refusal to reuse `extract/deck.py::count_pdf_pages`: none
    of the page dictionaries appear as literal bytes anywhere in the file, so a `/Type /Page`
    byte scan finds nothing at all while a real reader finds every page.
    """
    import struct

    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [%s] /Count %d >>"
        % (b" ".join(b"%d 0 R" % (index + 3) for index in range(pages)), pages),
    ]
    bodies += [b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"] * pages
    count = len(bodies)
    objstm_number = count + 1
    xref_number = count + 2

    pairs = bytearray()
    payload = bytearray()
    for number, body in enumerate(bodies, start=1):
        pairs += b"%d %d " % (number, len(payload))
        payload += body + b" "
    compressed = zlib.compress(bytes(pairs) + bytes(payload), 9)

    out = bytearray(b"%PDF-1.5\n%\xe2\xe3\xcf\xd3\n")
    objstm_at = len(out)
    out += (
        b"%d 0 obj\n<< /Type /ObjStm /N %d /First %d /Filter /FlateDecode /Length %d >>\n"
        b"stream\n" % (objstm_number, count, len(pairs), len(compressed))
    )
    out += compressed
    out += b"\nendstream\nendobj\n"

    def entry(kind: int, first: int, second: int) -> bytes:
        return bytes([kind]) + struct.pack(">I", first) + struct.pack(">H", second)

    entries = bytearray(entry(0, 0, 65535))
    for index in range(count):
        entries += entry(2, objstm_number, index)  # type 2: inside the object stream
    entries += entry(1, objstm_at, 0)
    xref_at = len(out)
    entries += entry(1, xref_at, 0)
    xref_payload = zlib.compress(bytes(entries), 9)
    out += (
        b"%d 0 obj\n<< /Type /XRef /Size %d /W [1 4 2] /Root 1 0 R /Filter /FlateDecode"
        b" /Length %d >>\nstream\n" % (xref_number, xref_number + 1, len(xref_payload))
    )
    out += xref_payload
    out += b"\nendstream\nendobj\nstartxref\n%d\n%%%%EOF\n" % xref_at
    return bytes(out)


def encrypted_pdf(pages: int = 3, password: str = "letmein") -> bytes:
    """A SHORT, VALID, PASSWORD-PROTECTED PDF — the shape that makes unfollowable advice.

    Deliberately under the page cap: the point of the fixture is that the document's LENGTH is
    fine and the citizen still cannot get past a refusal that talks about length. Built with
    pypdf rather than hand-assembled because the encryption dictionary is the part under test,
    and hand-writing one would be testing the fixture rather than the reader.
    """
    import io

    from pypdf import PdfWriter

    plain = PdfWriter()
    for _ in range(pages):
        plain.add_blank_page(width=200, height=200)
    unlocked = io.BytesIO()
    plain.write(unlocked)

    locked = PdfWriter(clone_from=io.BytesIO(unlocked.getvalue()))
    locked.encrypt(password)
    out = io.BytesIO()
    locked.write(out)
    return out.getvalue()
