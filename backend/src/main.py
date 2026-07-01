"""FastAPI application factory + composition root.

Configures structlog at import, then `create_app()` wires the middleware
(security headers + credentialed CORS), the boundary exception handlers, and the
v1 router. The lifespan's only teardown is closing the object-store client(s) on
shutdown (an unclosed Azure credential / aiohttp session leaks otherwise); no task
queue / Redis runs yet (ADR-0011).
"""

from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from starlette.middleware.cors import CORSMiddleware

from src.config import configure_logging, settings

configure_logging(is_production=settings.is_production)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # No background services to start this phase.
    yield
    # Shutdown: close the cached object-store client(s) + Azure credential so
    # their aiohttp sessions don't leak. A no-op when storage was never used.
    from src.services.storage import aclose_storage

    await aclose_storage()


def create_app() -> FastAPI:
    from src.api.v1.router import v1_router
    from src.core.errors import register_exception_handlers

    app = FastAPI(title="BIAL Backend", version="0.1.0", lifespan=lifespan)

    register_exception_handlers(app)

    @app.middleware("http")
    async def security_headers(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        # Applied to every response (including framework-generated 4xx/5xx),
        # which a route dependency cannot reach — so this must be middleware.
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[settings.FRONTEND_URL],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(v1_router)
    return app


app = create_app()
