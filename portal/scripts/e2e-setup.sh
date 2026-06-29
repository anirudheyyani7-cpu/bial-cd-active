#!/usr/bin/env bash
#
# Idempotent local prerequisites for the e2e suite (dev pass AND container pass).
# Brings up the backing services on the ports the app expects, creates the Azure
# object-store container, and ensures the QA user exists. Safe to re-run.
#
#   bash scripts/e2e-setup.sh
#
# Reads E2E_QA_EMAIL / E2E_QA_PASSWORD from portal/.env.e2e (copy .env.e2e.example
# first) — fails fast if unset, so QA passwords never live in committed source.
# Everything else (Mongo URI, Azurite connection string) comes from portal/.env,
# which add-user.js loads via dotenv.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1   # portal/

ENV_E2E=".env.e2e"
ok(){ printf '  \033[32m✓\033[0m %s\n' "$1"; }
die(){ printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

# --- QA creds: parse (don't source) — the Azurite conn string's ; would break
#     a naive `. .env.e2e`. grep just the two keys we need.
[ -f "$ENV_E2E" ] || die "$ENV_E2E not found. Run: cp .env.e2e.example .env.e2e  (then fill the secrets)"
getval(){ grep -E "^$1=" "$ENV_E2E" | head -1 | cut -d= -f2-; }
E2E_QA_EMAIL="$(getval E2E_QA_EMAIL)"
E2E_QA_PASSWORD="$(getval E2E_QA_PASSWORD)"
case "$E2E_QA_EMAIL" in ''|'<'*) die "E2E_QA_EMAIL is unset/placeholder in $ENV_E2E";; esac
case "$E2E_QA_PASSWORD" in ''|'<'*) die "E2E_QA_PASSWORD is unset/placeholder in $ENV_E2E";; esac

# --- Backing services (ports the app expects: Mongo :27017, Azurite :10000,
#     Gotenberg :3000). docker compose up is idempotent.
echo "Bringing up backing services (mongo, azurite, gotenberg) …"
docker compose up -d mongo azurite gotenberg >/dev/null 2>&1 || die "docker compose up failed"
for i in $(seq 1 40); do
  curl -fsS -o /dev/null "http://localhost:3000/health" 2>/dev/null && break
  [ "$i" = 40 ] && die "gotenberg never became healthy on :3000"
  sleep 0.5
done
ok "mongo / azurite / gotenberg up (gotenberg /health 200)"

# --- Azure object-store container (the app never creates buckets — it is a
#     deploy prerequisite). Use the HOST endpoint (127.0.0.1) from portal/.env.
node -e "
  require('dotenv/config');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cs = process.env.AZURE_STORAGE_CONNECTION_STRING;
  const bucket = process.env.OBJECT_STORE_BUCKET || 'bial-attachments';
  if ((process.env.OBJECT_STORE_PROVIDER||'').toLowerCase() !== 'azure') { console.log('  (provider!=azure — skipping container create)'); process.exit(0); }
  BlobServiceClient.fromConnectionString(cs).getContainerClient(bucket).createIfNotExists()
    .then(() => process.exit(0))
    .catch((e) => { console.error('  container create failed:', e.message); process.exit(1); });
" || die "could not create the Azurite object-store container"
ok "object-store container ensured"

# --- QA user (not covered by seed-bial-users.js). Idempotent upsert; password
#     comes from the env so it never lands in committed source.
node scripts/add-user.js "$E2E_QA_EMAIL" --name "E2E QA" --role user --password "$E2E_QA_PASSWORD" >/dev/null \
  && ok "QA user ensured ($E2E_QA_EMAIL)" \
  || die "add-user.js failed for $E2E_QA_EMAIL"

echo "Done. Next: 'npm run e2e' (dev) or 'npm run e2e:container' (built image)."
