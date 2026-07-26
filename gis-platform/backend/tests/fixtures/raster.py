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
