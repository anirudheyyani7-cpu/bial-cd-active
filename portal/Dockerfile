# BIAL Citizen Developer Portal — single-origin image (API + built SPA).
#
# The Express server (server.js) serves both the /api/* routes and the built
# Vite SPA from ./dist, so one container is the whole app. Build:
#
#   docker build -t bial-portal ./portal
#
# Run (env supplied at runtime — NEVER baked into the image):
#
#   docker run -p 3001:3001 --env-file ./portal/.env bial-portal
#
# Required runtime env (see .env.example): ANTHROPIC_FOUNDRY_API_KEY,
# AZURE_FOUNDRY_RESOURCE_NAME, MONGODB_URI, MONGODB_DATABASE, JWT_SECRET, etc.
# Cosmos collections (users / usage / feedback) must be pre-created out-of-band.

# ── Stage 1: build the SPA (needs devDependencies: vite, tailwind, …) ────────
FROM node:22-slim AS builder
WORKDIR /app

# Install with the lockfile first so this layer caches unless deps change.
COPY package.json package-lock.json ./
RUN npm ci

# Build the static SPA into /app/dist (hermetic — no secrets needed at build).
COPY . .
RUN npm run build

# ── Stage 2: runtime (production deps + server + built dist only) ────────────
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

# Production dependencies only (no vite/tailwind/test tooling in the final image).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Server code, the built SPA, and the seed/admin scripts (handy for one-off
# `docker run … node scripts/seed-bial-users.js`). src/, tests, configs excluded.
COPY server.js ./
COPY server ./server
COPY scripts ./scripts
COPY --from=builder /app/dist ./dist

# Drop root — the app only reads these files at runtime.
USER node

EXPOSE 3001

# No dedicated health route; /preview is an unauthenticated 200. Uses Node's
# built-in fetch (Node 22) so no curl/wget needs to be installed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3001)+'/preview').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
