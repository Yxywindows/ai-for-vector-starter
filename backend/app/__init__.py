"""GIS platform backend.

The PROJ shim runs at package import, before any module can pull in
rasterio. See app/core/geo_env.py for why the ordering matters.
"""

from app.core.geo_env import configure_proj

configure_proj()
