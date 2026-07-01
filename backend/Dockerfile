# syntax=docker/dockerfile:1
# Scaffolded runtime image for the FastAPI control-plane. NOT yet wired into the
# deploy pipeline — the production build runs on a Windows VM via `az acr build`
# (ADR-0015), so this has only been exercised locally. Keep it LF-only and
# cross-platform (the repo .gitattributes pins Dockerfile* to eol=lf).
FROM python:3.14-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv
WORKDIR /app

# Install runtime deps only (api group); the dev group (gates + tests) and
# migrations are run out-of-band, never from this image.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-group dev --group api

# Copy only the application package — narrows the image and avoids baking host
# artifacts/secrets in (ADR-0015: secrets are injected at runtime, never baked).
COPY src ./src

# Least privilege: run as an unprivileged user that owns /app.
RUN useradd --system --uid 10001 --home-dir /app app && chown -R app:app /app
USER app

# The venv is already correct; never re-sync (and thus re-install dev tooling)
# on container boot.
ENV UV_NO_SYNC=1

# Bind the platform-provided $PORT (App Service / ACA inject it), default 8000.
CMD ["sh", "-c", "exec uv run fastapi run src/main.py --host 0.0.0.0 --port ${PORT:-8000}"]
