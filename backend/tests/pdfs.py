"""Hand-rolled PDF fixtures for the upload page-cap admission.

WRITTEN BY HAND, NOT BY `pypdf`, AND THAT IS THE POINT. The thing under test is a `pypdf`
page count; building the fixture with the same library would only prove that pypdf agrees
with itself, and a bug in how the reader is driven would be invisible. These emit raw PDF
syntax — a classic cross-reference table, a catalog, a page-tree node and N page objects —
so the byte-level page count is a fact of the fixture rather than of the reader.

The ENCRYPTED three — `locked_pdf`, `restricted_pdf`, `ouroboros_pdf` — are the exception,
and are built by `pypdf` for the opposite reason: a standard-security encryption dictionary
is a key derivation rather than syntax, so hand-writing one would be testing the fixture. In
each of them the page count is still set here, explicitly, so it stays a fact of the fixture.

They are generated rather than committed because a 31-page binary in the tree is a blob
nobody can review, and the hostile one is 8 KB of syntax whose whole meaning is what it
does to a parser.
"""

from __future__ import annotations

import zlib
from typing import cast

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


def pdf_bigger_on_the_inside(*, pages: int, declares: int) -> bytes:
    """A PDF whose catalog DECLARES `declares` pages and whose page tree yields `pages`.

    One page object, listed in `/Kids` `pages` times — which is legal, cheap (six bytes a
    page) and exactly how a hostile upload buys twenty thousand pages inside a 120 KB file.
    A reader that trusts `/Count` sees a short document; one that walks the tree sees the
    real one. Hand-assembled like the rest of this module precisely because the gap between
    the two numbers has to be a fact of the FIXTURE and not of the reader under test.
    """
    kids = b" ".join([b"3 0 R"] * pages)
    return _assemble(
        [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, declares),
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
        ]
    )


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

    This is the fixture behind the refusal to reuse `extract/deck.py::count_pdf_pages`: none
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


def locked_pdf(pages: int = 3, password: str = "letmein") -> bytes:
    """A SHORT, VALID, PASSWORD-PROTECTED PDF — the shape that makes unfollowable advice.

    ★ THE ONLY FIXTURE HERE THAT MAY BE REFUSED FOR BEING ENCRYPTED, and the name says so:
    `restricted_pdf` below is encrypted too and must be ACCEPTED. What separates them is not
    `/Encrypt` — both carry it — but whether an empty password opens the file. This one's does
    not (`decrypt("")` answers `NOT_DECRYPTED`), so nothing can be read out of it at all.

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


def restricted_pdf(*, pages: int = 3, declares: int | None = None, owner: str = "") -> bytes:
    """AN ENCRYPTED PDF THAT IS NOT LOCKED — permission-restricted, EMPTY user password.

    The ordinary encrypted document in an office: the producer set permissions (no printing,
    no copying) and left the user password empty, so every reader opens it without asking
    anyone anything. pypdf attempts the empty password on construction, so it parses, and
    `decrypt("")` answers `OWNER_PASSWORD` when `owner` is empty too and `USER_PASSWORD` when
    it is not — never `NOT_DECRYPTED`. Both must be ACCEPTED; refusing on `/Encrypt` alone
    would refuse most of the encrypted PDFs a citizen owns.

    `declares` under-reports the catalog's `/Count` — the same "bigger on the inside" shape as
    `pdf_bigger_on_the_inside`, now wearing an encryption dictionary. That pairing is the whole
    of #194: pypdf's `get_num_pages()` returns `/Count` unwalked for ANY encrypted file, and
    stays that way after a successful decryption, so the two fixtures differing only in
    `/Encrypt` were counted as 20,000 pages and as 1.

    Built by pypdf, unlike its plain twin, because a standard-security encryption dictionary is
    a key derivation rather than syntax and hand-writing one would test the fixture. The page
    count stays a fact of the fixture even so: `/Kids` is assigned here, explicitly, as one page
    reference repeated `pages` times.
    """
    import io

    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject

    writer = PdfWriter()
    page = writer.add_blank_page(width=200, height=200)
    tree = cast(DictionaryObject, writer.root_object["/Pages"])
    tree[NameObject("/Kids")] = ArrayObject([page.indirect_reference] * pages)
    tree[NameObject("/Count")] = NumberObject(pages if declares is None else declares)
    writer.encrypt("", owner_password=owner)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


def ouroboros_pdf() -> bytes:
    """A PAGE TREE THAT EATS ITS OWN TAIL: root `/Pages` → a second `/Pages` → root, forever.

    There is no leaf anywhere in it, so a walk that does not carry a cycle guard never returns
    — which is the reason the count is taken with pypdf's own traversal instead of a
    hand-rolled one. pypdf tracks the ancestor path and raises `Detected cyclic page
    references.`, and the dispatch turns that into the same 400 a truncated file gets.

    Encrypted, because the plain version proves nothing new: the unencrypted path always
    walked. Before #194's fix this file was never walked at all — the declared `/Count 1` was
    handed straight back — so this fixture is red-if-reverted in exactly one direction, and if
    the guard ever goes it hangs until the governor kills it rather than answering.
    """
    import io

    from pypdf import PdfWriter
    from pypdf.generic import ArrayObject, DictionaryObject, NameObject, NumberObject

    writer = PdfWriter()
    writer.add_blank_page(width=200, height=200)
    tree = cast(DictionaryObject, writer.root_object["/Pages"])

    tail = DictionaryObject()
    tail[NameObject("/Type")] = NameObject("/Pages")
    tail[NameObject("/Count")] = NumberObject(1)
    tail_ref = writer._add_object(tail)
    tail[NameObject("/Kids")] = ArrayObject([tree.indirect_reference])

    tree[NameObject("/Kids")] = ArrayObject([tail_ref])
    tree[NameObject("/Count")] = NumberObject(1)
    writer.encrypt("", owner_password="")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
