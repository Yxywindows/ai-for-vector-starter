"""Make rasterio use the PROJ database shipped inside its own wheel.

A system-wide ``PROJ_LIB`` left behind by an unrelated GDAL/PROJ install --
PostgreSQL's bundled PostGIS is the usual culprit on Windows -- silently
wins over the wheel's own data directory. Every rasterio CRS lookup then
fails with "proj.db contains DATABASE.LAYOUT.VERSION.MINOR = 2 whereas a
number >= 6 is expected", which surfaces as an unhelpful CRSError deep
inside raster import or tiling.

This must run *before* rasterio is first imported: PROJ reads the variable
while building its context, so setting it afterwards has no effect. That is
why ``app/__init__.py`` calls it at package-import time rather than the
FastAPI lifespan, which runs far too late.

``pyproj`` (and therefore geopandas) is unaffected either way -- it resolves
its own bundled data independently -- so this narrows to rasterio and
rio-tiler.
"""

from __future__ import annotations

import os
import sysconfig
from pathlib import Path


def configure_proj() -> Path | None:
    """Point PROJ at rasterio's bundled database. Returns the path, or None."""
    bundle = Path(sysconfig.get_paths()["purelib"]) / "rasterio" / "proj_data"
    if not (bundle / "proj.db").is_file():
        return None
    os.environ["PROJ_LIB"] = str(bundle)
    os.environ["PROJ_DATA"] = str(bundle)
    return bundle
