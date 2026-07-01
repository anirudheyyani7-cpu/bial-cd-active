"""Shared FastAPI dependency aliases."""

from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from src.db.session import get_db

DbSession = Annotated[AsyncSession, Depends(get_db)]
