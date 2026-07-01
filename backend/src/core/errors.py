"""Application-wide exception handlers.

Two guarantees:
1. Validation errors never reflect submitted input back to the client. FastAPI's
   default 422 body includes an ``input`` field that echoes the rejected value —
   for a password field that means leaking the plaintext (and it may be logged).
   We return only ``type``/``loc``/``msg``.
2. Any unhandled exception returns a generic 500 with no internal detail; the real
   error is logged server-side only (`.claude/rules/security.md`: NEVER expose
   internal errors to the frontend).
"""

from __future__ import annotations

import structlog
from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

logger = structlog.get_logger()


def validation_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    # Typed as Exception to match Starlette's handler signature; Starlette only
    # dispatches RequestValidationError here.
    if not isinstance(exc, RequestValidationError):
        raise TypeError(
            f"validation_exception_handler received {type(exc).__name__}, "
            "expected RequestValidationError"
        )
    # Keep field location and message; drop `input` and `ctx`, which can carry the
    # submitted value (e.g. a plaintext password) or the whole request body.
    safe_errors = [
        {"type": err.get("type"), "loc": err.get("loc"), "msg": err.get("msg")}
        for err in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": safe_errors},
    )


def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    logger.error(
        "unhandled_exception",
        method=request.method,
        path=request.url.path,
        exc_info=exc,
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "Internal server error"},
    )


def register_exception_handlers(app: FastAPI) -> None:
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)
