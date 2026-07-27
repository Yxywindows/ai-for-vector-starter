"""Application factory. Import-time side effects are kept to zero on purpose."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import cast

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.router import api_router
from app.api.v1.routes import health
from app.core.config import Settings, get_settings
from app.core.errors import register_exception_handlers
from app.core.logging import configure_logging
from app.resources.dataset_pool import DatasetPool, get_raster_pool, set_raster_pool


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    settings: Settings = get_settings()
    settings.raster_dir.mkdir(parents=True, exist_ok=True)
    settings.upload_tmp_dir.mkdir(parents=True, exist_ok=True)

    from app.services.raster_tile_service import close_reader, open_reader

    # `DatasetPool[T]` is invariant in `T` (Task 11's public API is
    # `DatasetPool[object]`, deliberately generic over which resource it
    # pools), while `open_reader`/`close_reader` are concretely typed for
    # `Reader` (Task 12's interface). Neither side should widen -- the pool
    # stays a general-purpose resource pool, and the reader factory/closer
    # stay precisely typed for their one real caller -- so this cast marks
    # the single, deliberate erasure point between them.
    set_raster_pool(
        cast(
            "DatasetPool[object]",
            DatasetPool(
                factory=open_reader,
                closer=close_reader,
                max_open=settings.raster_pool_max_open,
                idle_ttl=settings.raster_pool_idle_ttl_seconds,
            ),
        )
    )
    try:
        yield
    finally:
        await get_raster_pool().close_all()


def create_app() -> FastAPI:
    settings = get_settings()
    configure_logging(settings.log_level)

    app = FastAPI(
        title="GIS Platform API",
        version="0.1.0",
        description="PostGIS-backed web GIS: layers, tiles, attributes, styling, editing.",
        lifespan=lifespan,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    register_exception_handlers(app)
    app.include_router(api_router, prefix=settings.api_prefix)
    # Unversioned probe endpoint: container orchestrators and load balancers
    # need a health check path that stays stable across an eventual
    # /api/v2, so it is mounted bare in addition to the versioned one.
    # Same handler, no prefix — this is wiring only.
    app.include_router(health.router)
    return app


app = create_app()
