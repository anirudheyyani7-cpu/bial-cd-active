#!/bin/sh
# Combined-image entrypoint for Azure App Service: start the Gotenberg/LibreOffice
# renderer on LOOPBACK ONLY, then run the portal as the foreground (PID 1) process.
#
# Why this shape:
#   - App Service routes ONLY the single public port (WEBSITES_PORT → the portal).
#     Gotenberg's :3000 is never mapped to the internet by the platform, so the
#     renderer is reachable only by the portal in the same container. That preserves
#     the "renderer not publicly exposed" property without a second container.
#   - The portal is the foreground process, so if IT dies the container dies and App
#     Service restarts it. If GOTENBERG dies, the portal keeps serving and deck
#     uploads return the clean 502/503 the code already maps (graceful degradation).
set -eu

# Align the renderer's own wall-clock with the portal's DECK_CONVERT_TIMEOUT_MS
# (seconds) so a hostile deck can't wedge a LibreOffice worker. Defaults to 60s.
TIMEOUT_MS="${DECK_CONVERT_TIMEOUT_MS:-60000}"
TIMEOUT_S="$(( TIMEOUT_MS / 1000 ))"
[ "$TIMEOUT_S" -lt 1 ] && TIMEOUT_S=60

# Gotenberg defaults to :3000. App Service only routes the portal port publicly,
# so :3000 stays private. --api-timeout is the documented flag (see ops README).
gotenberg --api-port=3000 --api-timeout="${TIMEOUT_S}s" &
RENDERER_PID=$!

# Forward App Service's stop signals so both processes shut down cleanly.
trap 'kill -TERM "$RENDERER_PID" 2>/dev/null || true' TERM INT

exec node server.js
