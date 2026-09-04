"""Dependency seams for the deploy routes.

Both providers hand back `None` rather than raising when `DEPLOY__*` is unconfigured: a
`Depends` is solved before the route body's first statement, so a raising provider escapes the
body's own `try` and turns the 503 these routes document into an undocumented 500.
"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends

from src.services.deploy.aca_publish import (
    DeployNotConfiguredError,
    PublishedAppRemover,
    get_published_apps,
)
from src.services.deploy.service import DeployService, get_deploy_service


def deploy_service_or_none() -> DeployService | None:
    try:
        return get_deploy_service()
    except DeployNotConfiguredError:
        return None


OptionalDeployService = Annotated[DeployService | None, Depends(deploy_service_or_none)]


def published_app_remover_or_none() -> PublishedAppRemover | None:
    try:
        return get_published_apps()
    except DeployNotConfiguredError:
        return None


OptionalPublishedAppRemover = Annotated[
    PublishedAppRemover | None, Depends(published_app_remover_or_none)
]
