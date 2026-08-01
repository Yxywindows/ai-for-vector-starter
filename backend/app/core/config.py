"""Typed application settings, loaded from environment / .env with prefix GIS_."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_prefix="GIS_", extra="ignore", case_sensitive=False
    )

    environment: str = "development"
    log_level: str = "INFO"
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["http://localhost:1317"]

    # Async URL used by the app; the sync URL is derived from it in db/sync_engine.py.
    database_url: str = "postgresql+asyncpg://gis:gis@localhost:5401/gis_platform"
    db_pool_size: int = 10
    db_max_overflow: int = 5
    db_echo: bool = False

    # Filesystem
    data_dir: Path = Path("var/data")
    upload_max_bytes: int = 512 * 1024 * 1024

    # Schemas the platform owns
    metadata_schema: str = "gis"
    import_schema: str = "gis_data"

    # Memory guard rails
    feature_bbox_limit: int = 2000
    # Performance fast-path knobs (see docs/superpowers/plans/
    # 2026-08-01-gis-performance-and-completeness-plan.md, Phase 1).
    snapshot_cache_max_entries: int = 512
    tile_cache_max_bytes: int = 64 * 1024 * 1024
    geojson_default_precision: int = 6
    # The unfiltered attribute total uses the planner estimate only above
    # this row count: small tables count exactly (cheap, and edits make a
    # stale estimate visibly wrong there), large tables take the fast path
    # where drift of a few rows is imperceptible and count(*) is the cost.
    attribute_count_estimate_min: int = 100_000
    attribute_page_max: int = 500
    raster_pool_max_open: int = 8
    raster_pool_idle_ttl_seconds: float = 300.0

    # Staged JSON/GeoJSON import
    import_allowed_extensions: list[str] = [".json", ".geojson"]
    import_max_file_bytes: int = 64 * 1024 * 1024
    import_max_features: int = 50_000
    import_preview_max_features: int = 5_000

    @property
    def raster_dir(self) -> Path:
        return self.data_dir / "rasters"

    @property
    def upload_tmp_dir(self) -> Path:
        return self.data_dir / "tmp"


@lru_cache
def get_settings() -> Settings:
    return Settings()
