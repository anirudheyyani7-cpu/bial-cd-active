#!/usr/bin/env bash
#
# Container migration-validation harness — builds the SINGLE-CONTAINER image
# (portal + in-container Gotenberg), runs it, and runs BOTH proof layers against
# it on :3001:
#
#   LAYER 1 (authoritative packaging gate): scripts/qa-attachments.sh @ :3001 —
#           upload → Gotenberg convert → store → original .pptx download, no
#           browser, no live model. This is what actually GATES packaging.
#   LAYER 2 (UX/fidelity parity): the SAME Playwright suite with
#           E2E_BASE_URL=http://localhost:3001 — exercises the built SPA, the
#           strict helmet CSP, single-origin SSE, and the real file-picker, and
#           asserts what dev can't (zero CSP violations / console errors).
#
# Owns the container lifecycle: build → run → /preview health-gate → tests →
# guaranteed teardown (trap). Usage:  bash scripts/e2e-container.sh
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1   # portal/

IMAGE=bial-portal:combined
CONTAINER=bial-portal-e2e
ENV_E2E=.env.e2e
PORT=3001

die(){ printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }
info(){ printf '\033[36m• %s\033[0m\n' "$1"; }
ok(){ printf '\033[32m✓ %s\033[0m\n' "$1"; }

[ -f "$ENV_E2E" ] || die "$ENV_E2E not found — cp .env.e2e.example .env.e2e and fill the secrets."

# Pre-flight: the container publishes :$PORT, so the host port must be free. The
# dev API (npm run server) binds the same port — the container pass replaces it,
# it does not run alongside it. Fail fast with guidance, not a cryptic docker error.
if lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  die "host port ${PORT} is already in use (the dev API / 'npm run server'?). Stop it first — the container needs :${PORT}."
fi

# Idempotent teardown on ANY exit (success, failure, or Ctrl-C) — no orphans.
cleanup(){ docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# --- QA creds from .env.e2e (parse, don't source — the conn string's ; breaks a
#     naive `. .env.e2e`).
getval(){ grep -E "^$1=" "$ENV_E2E" | head -1 | cut -d= -f2-; }
E2E_QA_EMAIL="$(getval E2E_QA_EMAIL)"
E2E_QA_PASSWORD="$(getval E2E_QA_PASSWORD)"
case "$E2E_QA_EMAIL" in ''|'<'*) die "E2E_QA_EMAIL unset/placeholder in $ENV_E2E";; esac
case "$E2E_QA_PASSWORD" in ''|'<'*) die "E2E_QA_PASSWORD unset/placeholder in $ENV_E2E";; esac

# --- Host prep: Mongo + Azurite ONLY. NOT a host Gotenberg — the renderer runs
#     inside the container; a host :3000 would confound the isolation check below.
info "Host prep: mongo + azurite + object-store container + QA user"
docker compose up -d mongo azurite >/dev/null 2>&1 || die "docker compose up (mongo, azurite) failed"
# Object-store container (HOST endpoint 127.0.0.1 from portal/.env — add-user.js
# and this snippet talk to the host; the CONTAINER uses host.docker.internal).
node -e "
  require('dotenv/config');
  const { BlobServiceClient } = require('@azure/storage-blob');
  if ((process.env.OBJECT_STORE_PROVIDER||'').toLowerCase() !== 'azure') process.exit(0);
  BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING)
    .getContainerClient(process.env.OBJECT_STORE_BUCKET||'bial-attachments').createIfNotExists()
    .then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
" || die "object-store container create failed"
# QA user in the target Mongo (host Mongo == the container's host.docker.internal Mongo).
node scripts/add-user.js "$E2E_QA_EMAIL" --name "E2E QA" --role user --password "$E2E_QA_PASSWORD" >/dev/null \
  || die "add-user.js failed for $E2E_QA_EMAIL"
ok "host services + QA user ready"

# --- Build the combined image (cached layers make re-runs fast).
info "Building $IMAGE"
docker build -f Dockerfile.appservice -t "$IMAGE" . >/dev/null || die "image build failed"
ok "image built"

# --- Run: reach host services via host.docker.internal; FORCE the Gotenberg
#     loopback override AFTER --env-file (the single most likely works-in-dev-not-
#     in-container cause); publish ONLY the portal port.
info "Starting container"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  --add-host host.docker.internal:host-gateway \
  --env-file "$ENV_E2E" \
  -e GOTENBERG_URL=http://localhost:3000 \
  -p "${PORT}:3001" \
  "$IMAGE" >/dev/null || die "docker run failed"

# --- Health gate: /preview 200, budget 120s (start-period 30s + LibreOffice warmup).
info "Waiting for /preview 200 (≤120s)"
ready=
for i in $(seq 1 120); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/preview" 2>/dev/null)" = 200 ]; then ready=1; break; fi
  if [ -z "$(docker ps -q -f name="^${CONTAINER}$")" ]; then
    echo "--- container exited early; last logs ---"; docker logs "$CONTAINER" 2>&1 | tail -40
    die "container exited before becoming ready"
  fi
  sleep 1
done
[ -n "$ready" ] || { docker logs "$CONTAINER" 2>&1 | tail -40; die "container never reached /preview 200 within 120s"; }
ok "container ready (/preview 200)"

# --- Loopback isolation: ONLY the portal port is published; the renderer stays
#     private. Checking `docker port` is unconfounded by any stray host Gotenberg.
info "Loopback isolation"
if docker port "$CONTAINER" | grep -q '^3000/'; then die ":3000 is published — renderer is exposed!"; fi
ok ":3000 NOT published (renderer private)"
docker port "$CONTAINER" | grep -q '3001/' || die ":3001 (portal) is not published"
ok ":3001 published (portal)"
docker exec "$CONTAINER" node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
  && ok "gotenberg reachable on the container's loopback :3000" \
  || die "gotenberg not reachable inside the container"

# === LAYER 1 — deterministic packaging gate (authoritative) ===================
info "Deterministic gate: qa-attachments.sh @ :${PORT} (no browser, no model)"
BASE="http://localhost:${PORT}" bash scripts/qa-attachments.sh || die "deterministic gate (qa-attachments.sh) FAILED against the container"
ok "deterministic packaging gate passed"

# === LAYER 2 — browser parity (UX/fidelity, + CSP/console/asset assertions) ===
info "Browser parity: Playwright suite @ :${PORT}"
E2E_BASE_URL="http://localhost:${PORT}" npx playwright test || die "Playwright suite FAILED against the container"
ok "browser parity suite passed"

echo
ok "CONTAINER MIGRATION VALIDATION PASSED — packaging gate + browser parity green"
