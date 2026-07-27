"""A synchronous engine, used only for geopandas' bulk `to_postgis` write.

geopandas has no async path. Rather than reimplement its type mapping, the
import runs on a worker thread against a short-lived sync engine. NullPool
keeps it from holding connections between imports.
"""

from __future__ import annotations

from functools import lru_cache

from sqlalchemy import Engine, create_engine
from sqlalchemy.pool import NullPool

from app.core.config import get_settings


@lru_cache
def get_sync_engine() -> Engine:
    url = get_settings().database_url.replace("+asyncpg", "+psycopg")
    return create_engine(url, poolclass=NullPool, future=True)
