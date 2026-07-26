"""Synthesise a small GeoTIFF so raster tests need no binary assets in git."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import rasterio
from rasterio.transform import from_bounds

BOUNDS = (100.0, 30.0, 101.0, 31.0)
SIZE = 64


@pytest.fixture
def sample_geotiff(tmp_path: Path) -> Path:
    path = tmp_path / "sample.tif"
    data = np.tile(np.arange(SIZE, dtype="uint8"), (SIZE, 1))
    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "uint8",
        "crs": "EPSG:4326",
        "transform": from_bounds(*BOUNDS, SIZE, SIZE),
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(data, 1)
    return path


@pytest.fixture
def sample_geotiff_no_crs(tmp_path: Path) -> Path:
    path = tmp_path / "nocrs.tif"
    data = np.zeros((SIZE, SIZE), dtype="uint8")
    with rasterio.open(
        path, "w", driver="GTiff", height=SIZE, width=SIZE, count=1, dtype="uint8"
    ) as dataset:
        dataset.write(data, 1)
    return path


@pytest.fixture
def sample_geotiff_all_nodata(tmp_path: Path) -> Path:
    """Every pixel equals the nodata value. A real CRS is present -- this
    must pass that check -- but GDAL has no valid pixels anywhere to
    compute min/max/mean from, which is the natural case where statistics
    genuinely cannot be computed."""
    path = tmp_path / "allnodata.tif"
    data = np.zeros((SIZE, SIZE), dtype="uint8")
    profile = {
        "driver": "GTiff",
        "height": SIZE,
        "width": SIZE,
        "count": 1,
        "dtype": "uint8",
        "crs": "EPSG:4326",
        "transform": from_bounds(*BOUNDS, SIZE, SIZE),
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(data, 1)
    return path


# Larger than 512x512 in both dimensions, and left in GDAL's default
# strip layout (no `tiled=True` creation option) -- both are required for
# rio-cogeo's validator to actually reject it. `sample_geotiff` above is
# 64x64, which GDAL's COG validator accepts outright (tiling/overview
# requirements only kick in above 512px), so it never exercises the
# `cog_translate` conversion branch. This fixture forces that branch to
# really run. 600x600 keeps the write/convert cost under a tenth of a
# second while still crossing the 512px threshold.
LARGE_SIZE = 600


@pytest.fixture
def sample_geotiff_not_a_cog(tmp_path: Path) -> Path:
    path = tmp_path / "large.tif"
    row = (np.arange(LARGE_SIZE) % 256).astype("uint8")
    data = np.tile(row, (LARGE_SIZE, 1))
    profile = {
        "driver": "GTiff",
        "height": LARGE_SIZE,
        "width": LARGE_SIZE,
        "count": 1,
        "dtype": "uint8",
        "crs": "EPSG:4326",
        "transform": from_bounds(*BOUNDS, LARGE_SIZE, LARGE_SIZE),
        "nodata": 0,
    }
    with rasterio.open(path, "w", **profile) as dataset:
        dataset.write(data, 1)
    return path
