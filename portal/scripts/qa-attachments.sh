#!/usr/bin/env bash
#
# Attachment integration QA — runs against the LIVE stack:
#   API (:3001, `npm run server`) + MinIO (docker `bial-minio`, bucket
#   `bial-attachments`) + Mongo (docker `bial-mongo`, db citizen_portal).
#
# Covers every supported attachment kind (PNG/JPEG/GIF/WebP/PDF bytes → object
# store) and every documented rejection (unsupported type, magic-byte mismatch,
# oversize, body cap, bad id, missing fields), plus download round-trip, per-user
# quota accounting, and cross-user isolation (IDOR). Repeatable: deletes the
# attachment objects it creates. Fixtures are byte-exact (magic-valid) temp files.
#
# Usage:  bash scripts/qa-attachments.sh
set -uo pipefail
BASE=${BASE:-http://localhost:3001}
U_EMAIL=anant.gupta@rvaiglobal.com; U_PW=RvaiBial@2026
A_EMAIL=admin@bial.test;            A_PW=BialAdmin@2026
MONGO_CT=bial-mongo
FX=$(mktemp -d); BODY=/tmp/qa_att_body; REQ=/tmp/qa_att_req.json
pass=0; fail=0; CREATED=()
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  \033[31m✗\033[0m %s — %s\n' "$1" "$2"; fail=$((fail+1)); }

# ---- byte-exact, magic-valid fixtures -------------------------------------
python3 - "$FX" <<'PY'
import sys,os,zipfile
d=sys.argv[1]; w=lambda n,b: open(os.path.join(d,n),'wb').write(b)
w('png',  b'\x89PNG\r\n\x1a\n'+b'\x00'*64)                       # 89 50 4E 47
w('jpg',  b'\xff\xd8\xff\xe0'+b'\x00'*64)                        # FF D8
w('gif',  b'GIF89a'+b'\x00'*64)                                  # GIF8
w('webp', b'RIFF'+(80).to_bytes(4,'little')+b'WEBP'+b'VP8 '+b'\x00'*64)  # RIFF..WEBP
w('pdf',  b'%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n')              # %PDF
w('svg',  b'<svg xmlns="http://www.w3.org/2000/svg"/>')         # unsupported
w('bmp',  b'BM'+b'\x00'*64)                                      # unsupported
w('zip',  b'PK\x03\x04'+b'\x00'*64)                             # ZIP magic, no OPC part (bad office)
w('wave', b'RIFF'+(80).to_bytes(4,'little')+b'WAVE'+b'\x00'*64) # RIFF but not WEBP
w('big',  b'\x89PNG\r\n\x1a\n'+b'\x00'*4500000)                 # ~4.3MB > 4MB cap, b64 < 6MB body
w('huge', b'\x89PNG\r\n\x1a\n'+b'\x00'*5200000)                 # b64 > 6MB body cap
# Real OOXML fixtures (zipfile = stdlib) — parseable by mammoth / SheetJS.
def zw(name, files):
    with zipfile.ZipFile(os.path.join(d,name),'w',zipfile.ZIP_DEFLATED) as z:
        for n,c in files.items(): z.writestr(n,c)
zw('docx', {
 '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
 'word/document.xml':'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>QA Heading</w:t></w:r></w:p><w:p><w:r><w:t>QA body line.</w:t></w:r></w:p></w:body></w:document>',
})
zw('xlsx', {
 '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
 '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml':'<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="QA" sheetId="1" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml':'<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Region</t></is></c><c r="B1" t="inlineStr"><is><t>Sales</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>100</v></c></row></sheetData></worksheet>',
})
PY

login(){ curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$1\",\"password\":\"$2\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("accessToken",""))'; }
uuid(){ python3 -c 'import uuid;print(uuid.uuid4())'; }
# build an upload body file; args: aid mediaType fixture  (mediaType "" => omit; fixture "" => empty base64)
mkbody(){ python3 - "$1" "$2" "${3:-}" "$FX" > "$REQ" <<'PY'
import sys,json,base64,os
aid,mt,fx,d=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
o={"attachmentId":aid,"name":"qa-"+(fx or "x")}
if mt: o["mediaType"]=mt
o["base64"]=base64.b64encode(open(os.path.join(d,fx),'rb').read()).decode() if fx else ""
print(json.dumps(o))
PY
}
UP(){ CODE=$(curl -s -o "$BODY" -w '%{http_code}' -X POST "$BASE/api/attachments" \
  -H "Authorization: Bearer $1" -H 'Content-Type: application/json' --data @"$REQ"); }
GET(){ curl -s -o "$2" -w '%{http_code}' "$BASE/api/attachments/$1" -H "Authorization: Bearer ${3:-$UT}"; }
DEL(){ curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/attachments/$1" -H "Authorization: Bearer $UT"; }
msg(){ python3 -c 'import sys,json;print(json.load(open("'"$BODY"'")).get("error",{}).get("message",""))' 2>/dev/null; }

UT=$(login "$U_EMAIL" "$U_PW"); AT=$(login "$A_EMAIL" "$A_PW")
[ -n "$UT" ] && [ -n "$AT" ] || { echo "LOGIN FAILED (rate limit?)"; exit 1; }
echo "tokens ok. base=$BASE"

echo; echo "── Supported types: upload (201) → kind → download round-trip ──"
for f in png jpg gif webp pdf; do
  case $f in
    png)  mt=image/png;       kind=image;;
    jpg)  mt=image/jpeg;      kind=image;;
    gif)  mt=image/gif;       kind=image;;
    webp) mt=image/webp;      kind=image;;
    pdf)  mt=application/pdf;  kind=document;;
  esac
  aid=$(uuid); mkbody "$aid" "$mt" "$f"; UP "$UT"
  if [ "$CODE" = 201 ]; then
    k=$(python3 -c 'import sys,json;print(json.load(open("'"$BODY"'"))["attachment"]["kind"])')
    [ "$k" = "$kind" ] && ok "$f upload 201, kind=$k" || no "$f kind" "got $k want $kind"
    CREATED+=("$aid")
    g=$(GET "$aid" /tmp/qa_dl); src=$(shasum -a256 "$FX/$f"|cut -d' ' -f1); dl=$(shasum -a256 /tmp/qa_dl|cut -d' ' -f1)
    [ "$g" = 200 ] && [ "$src" = "$dl" ] && ok "$f download 200, bytes match" || no "$f download" "code=$g sha_match=$([ "$src" = "$dl" ]&&echo y||echo n)"
  else no "$f upload" "code=$CODE msg=$(msg)"; fi
done

echo; echo "── Office (.docx/.xlsx): upload (201) → kind=office, format, extracted text → download round-trip ──"
WORD_MT=application/vnd.openxmlformats-officedocument.wordprocessingml.document
XLSX_MT=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet
ofield(){ python3 -c 'import sys,json;print(json.load(open("'"$BODY"'"))["attachment"].get("'"$1"'",""))' 2>/dev/null; }
for f in docx xlsx; do
  case $f in
    docx) mt=$WORD_MT;  fmt=word;  want='# QA Heading';;
    xlsx) mt=$XLSX_MT;  fmt=excel; want='## Sheet: QA';;
  esac
  aid=$(uuid); mkbody "$aid" "$mt" "$f"; UP "$UT"
  if [ "$CODE" = 201 ]; then
    k=$(ofield kind); ff=$(ofield format); txt=$(ofield text)
    [ "$k" = office ] && [ "$ff" = "$fmt" ] && ok "$f upload 201, kind=office, format=$ff" || no "$f office descriptor" "kind=$k format=$ff (want office/$fmt)"
    echo "$txt" | grep -qF "$want" && ok "$f extracted text contains \"$want\"" || no "$f extracted text" "missing \"$want\" in: $txt"
    CREATED+=("$aid")
    g=$(GET "$aid" /tmp/qa_dl); src=$(shasum -a256 "$FX/$f"|cut -d' ' -f1); dl=$(shasum -a256 /tmp/qa_dl|cut -d' ' -f1)
    [ "$g" = 200 ] && [ "$src" = "$dl" ] && ok "$f download 200, ORIGINAL bytes match" || no "$f download" "code=$g sha_match=$([ "$src" = "$dl" ]&&echo y||echo n)"
  else no "$f upload" "code=$CODE msg=$(msg)"; fi
done

echo; echo "── Rejections: correct status + message ──"
chk(){ # name expected_code expected_substr
  if [ "$CODE" = "$2" ] && echo "$(msg)" | grep -qF "$3"; then ok "$1 → $2 \"$(msg)\""
  else no "$1" "code=$CODE (want $2) msg=\"$(msg)\" (want ~\"$3\")"; fi; }
aid=$(uuid); mkbody "$aid" "text/plain" png;        UP "$UT"; chk "text/plain rejected"      400 "sent inline"
aid=$(uuid); mkbody "$aid" "image/svg+xml" svg;     UP "$UT"; chk "image/svg+xml unsupported" 400 "Unsupported attachment type: image/svg+xml"
aid=$(uuid); mkbody "$aid" "image/bmp" bmp;         UP "$UT"; chk "image/bmp unsupported"     400 "Unsupported attachment type: image/bmp"
aid=$(uuid); mkbody "$aid" "application/zip" zip;   UP "$UT"; chk "application/zip unsupported" 400 "Unsupported attachment type: application/zip"
aid=$(uuid); mkbody "$aid" "$WORD_MT" zip;          UP "$UT"; chk "zip mislabelled as .docx"   400 "Not a valid Word"
aid=$(uuid); mkbody "$aid" "$XLSX_MT" png;          UP "$UT"; chk "png mislabelled as .xlsx"   400 "Not a valid Office file"
aid=$(uuid); mkbody "$aid" "image/png" gif;         UP "$UT"; chk "magic mismatch (png≠gif)"  400 "do not match the declared type image/png"
aid=$(uuid); mkbody "$aid" "image/webp" wave;       UP "$UT"; chk "webp RIFF but not WEBP"     400 "do not match the declared type image/webp"
aid=$(uuid); mkbody "$aid" "image/png" "";          UP "$UT"; chk "empty bytes"               400 "missing bytes"
aid=$(uuid); mkbody "$aid" "" png;                  UP "$UT"; chk "missing mediaType"          400 "mediaType is required"
mkbody "../etc/passwd" "image/png" png;             UP "$UT"; chk "bad attachment id"          400 "Invalid attachment id"
aid=$(uuid); mkbody "$aid" "image/png" big;         UP "$UT"; chk "oversize >4MB"              413 "too large (max 4 MB)"
aid=$(uuid); mkbody "$aid" "image/png" huge;        UP "$UT"; chk "request body >6MB cap"      413 ""

echo; echo "── Security / isolation ──"
A1=${CREATED[0]}
g=$(GET "$A1" /dev/null "$UT"); [ "$g" = 200 ] && ok "owner GET own attachment → 200" || no "owner GET" "code=$g"
g=$(GET "$A1" /dev/null "$AT"); [ "$g" = 404 ] && ok "admin GET user's attachment → 404 (IDOR closed)" || no "cross-user GET" "code=$g"
g=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/attachments/$A1"); [ "$g" = 401 ] && ok "no-token GET → 401" || no "no-token GET" "code=$g"

echo; echo "── Quota accounting (attachment_usage) ──"
TOTAL=$(docker exec "$MONGO_CT" mongosh "mongodb://localhost:27017/citizen_portal" --quiet --eval "print((db.getSiblingDB('citizen_portal').attachment_usage.findOne({_id:'$U_EMAIL'})||{}).total||0)")
[ "${TOTAL:-0}" -gt 0 ] && ok "attachment_usage.total incremented (= $TOTAL bytes)" || no "quota counter" "total=$TOTAL"

PROVIDER=$(grep -E '^OBJECT_STORE_PROVIDER=' .env 2>/dev/null | cut -d= -f2 | tr -d '"' | tr 'A-Z' 'a-z'); PROVIDER=${PROVIDER:-s3}
echo; echo "── Objects physically in the store (provider=$PROVIDER, key att/<user>/<id>) ──"
if [ "$PROVIDER" = azure ]; then
  CS=$(grep -E '^AZURE_STORAGE_CONNECTION_STRING=' .env | cut -d= -f2-)
  AZURE_STORAGE_CONNECTION_STRING="$CS" node -e "
    const { BlobServiceClient } = require('@azure/storage-blob');
    (async()=>{ const c=BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING).getContainerClient('bial-attachments');
      for await (const b of c.listBlobsFlat()) console.log('    '+b.name+'  '+b.properties.contentLength+'B  '+b.properties.contentType); })().catch(e=>console.log('    (list error) '+e.message));"
else
  NET=$(docker inspect bial-minio -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
  docker run --rm --entrypoint /bin/sh --network "$NET" minio/mc -c \
    "mc alias set local http://minio:9000 minioadmin minioadmin >/dev/null 2>&1 && mc ls --recursive local/bial-attachments" 2>/dev/null | sed 's/^/    /' | head -20
fi

echo; echo "── Delete round-trip ──"
d=$(DEL "$A1"); [ "$d" = 200 ] && ok "DELETE own attachment → 200" || no "DELETE" "code=$d"
g=$(GET "$A1" /dev/null "$UT"); [ "$g" = 404 ] && ok "GET after delete → 404 (object gone)" || no "GET after delete" "code=$g"

echo; echo "── Cleanup (remove remaining test objects from MinIO) ──"
for a in "${CREATED[@]:1}"; do DEL "$a" >/dev/null; done; ok "deleted ${#CREATED[@]} test objects"

echo; echo "════════ RESULT: $pass passed, $fail failed ════════"
rm -rf "$FX"
exit $([ "$fail" = 0 ] && echo 0 || echo 1)
