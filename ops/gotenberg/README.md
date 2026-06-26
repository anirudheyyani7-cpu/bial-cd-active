# Gotenberg sidecar — `.pptx` → PDF for deck chat attachments

The portal accepts PowerPoint (`.pptx`) chat attachments by converting them to a
**PDF** server-side and handing that PDF to Claude as a vision document block —
the model never sees raw `.pptx`. The conversion engine is a self-hosted
[Gotenberg](https://gotenberg.dev) sidecar (LibreOffice productized as a stateless
HTTP service), so confidential BIAL/KPMG decks **never leave the Azure tenant**.

The portal talks to exactly one Gotenberg route:

```
POST {GOTENBERG_URL}/forms/libreoffice/convert     (multipart, field name: files)
```

## Feature gate (dark by default)

The `.pptx` path is OFF unless **both** are set on the portal server:

| Var | Meaning |
| --- | --- |
| `DECK_ATTACHMENTS_ENABLED=true` | Master switch (literal string `true`). |
| `GOTENBERG_URL` | Base URL of a reachable sidecar (no trailing slash needed). |
| `MAX_DECK_PAGES` | Optional page cap (default `100`). Over-cap = clean `413`. |

With either of the first two missing, uploads are rejected with a clear message
(never a 500), and the composer hides `.pptx` behind the client flag
`src/config/features.js → DECK_ATTACHMENTS_ENABLED`. See `portal/.env.example`.

## Local development

`portal/docker-compose.yml` ships a `gotenberg` service on `:3000` using the
stock image — fine for dev:

```sh
cd portal && docker compose up -d gotenberg
# .env: DECK_ATTACHMENTS_ENABLED=true  GOTENBERG_URL=http://localhost:3000
```

## Production deploy (Azure Container Apps / App Service sidecar)

Run Gotenberg as an in-tenant sidecar reachable only from the portal API over the
internal network. Point `GOTENBERG_URL` at its internal address (e.g.
`http://gotenberg`); do **not** expose it publicly.

### Image

Build the hardened image in this directory (pre-installs MS-metric fonts so decks
don't reflow) and push it to your in-tenant registry:

```sh
docker build -t <registry>/bial-gotenberg:<tag> ops/gotenberg
```

**Pin a tag whose bundled LibreOffice meets the security floor** (≥ 24.8.5 /
25.2.1) for CVE-2024-12425, CVE-2024-12426, CVE-2025-1080 — the input bytes are
untrusted uploads. Verify: `docker run --rm <image> libreoffice --version`.

### Hardening checklist (mandatory, not optional)

This is the first time untrusted user bytes are fed to a **native renderer**
(LibreOffice) — a much larger attack surface than the in-process SheetJS/mammoth
parsers. The portal already validates **before** the renderer is touched (size
cap → OPC `ppt/presentation.xml` gate → zip-bomb guard → page cap), but the
container must still be locked down:

- [ ] **No network egress.** Deny-by-default egress; allow only ingress from the
      portal API. The renderer never needs the internet.
- [ ] **Read-only root filesystem**, with a small writable `tmpfs` for Gotenberg's
      scratch dir only.
- [ ] **Drop all Linux capabilities**; run as the non-root `gotenberg` user
      (the base image already does); add a seccomp profile.
- [ ] **Per-job timeout + hard kill.** Set Gotenberg's API timeout at or below the
      portal's conversion wall-clock timeout so a hostile deck can't wedge a worker
      (e.g. `gotenberg --api-timeout=60s`). The portal aborts independently too.
- [ ] **Macros disabled** (LibreOffice macro execution off — Gotenberg's default).
- [ ] **Resource limits.** Cap CPU/memory so a pathological deck degrades one job,
      not the node.
- [ ] **Patched + pinned.** Track the LibreOffice CVE floor above; redeploy on new
      advisories. Pin by digest, not a moving tag.

### Sizing

This plan ships a **single** sidecar sized for POC load; conversion is synchronous
at attach time (1–8 s typical). Autoscaling / an N-replica queue and async
job-based conversion for very large decks are deferred follow-up work.

## Why PDF, not text extraction

`.docx`/`.xlsx` survive as text, so the portal extracts Markdown for them. A deck
is a **visual** medium (diagrams, SmartArt, charts, layout); text extraction
would discard most of its meaning. Rendering to PDF preserves the visuals, and
Claude reads PDFs with vision (per-page rasterization + text). Accepted losses:
LibreOffice may substitute fonts or drift on complex SmartArt, and the PDF is a
static final frame (no animations/transitions).
