# BIAL Backend (FastAPI control-plane)

Phase-1 foundation for the BIAL Citizen Developer Platform control-plane. Replaces
the Express relay incrementally (strangler-fig, ADR-0001). See
`docs/plans/2026-07-01-001-feat-backend-foundation-scaffold-plan.md`.

## Stack

FastAPI · async SQLAlchemy 2.0 + asyncpg · Alembic · PostgreSQL 18 (pgvector,
UUIDv7) · structlog · pluggable object store (Azure Blob / S3). Managed with `uv`
(ADR-0002). Python 3.14.

## Local bootstrap

```sh
# 1. Install deps + create the venv
uv sync

# 2. Start Postgres 18 + pgvector
docker compose up -d db

# 3. Create the app + test databases (first run only)
docker compose exec db psql -U bial -d bial -c "CREATE DATABASE bial_test;"

# 4. Env files
cp .env.example .env
cp .env.test.example .env.test

# 5. Apply migrations
uv run alembic upgrade head

# 6. Run the API
uv run fastapi run src/main.py
# health: curl localhost:8000/v1/health
```

## Quality gates (all must pass — ADR-0003)

```sh
uv run ruff format --check
uv run ruff check
uv run ty check
uv run mypy src tests
uv run pyright src tests
uv run pytest                       # default lane: needs the Postgres test DB

# Storage round-trips (opt-in) — start MinIO + Azurite first, then run the lane:
docker compose -f docker-compose.test.yml up -d
uv run pytest -m integration
```

## Layout

`src/config.py` (fail-first Settings + logging) · `src/db/` (Base, mixins,
session) · `src/api/v1/<domain>/` · `src/services/storage/` (object store) ·
`alembic/` (migrations). Single-tenant: every user-data row is scoped by
`user_id`, never `org_id` (ADR-0004).
