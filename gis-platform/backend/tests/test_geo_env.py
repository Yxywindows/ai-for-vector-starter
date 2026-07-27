import os
import sysconfig
from pathlib import Path

from app.core.geo_env import configure_proj


def test_points_proj_at_the_bundled_rasterio_database() -> None:
    bundle = configure_proj()
    expected = Path(sysconfig.get_paths()["purelib"]) / "rasterio" / "proj_data"
    assert bundle == expected
    assert (bundle / "proj.db").is_file()
    assert os.environ["PROJ_LIB"] == str(expected)
    assert os.environ["PROJ_DATA"] == str(expected)


def test_is_idempotent() -> None:
    first = configure_proj()
    assert configure_proj() == first


def test_rasterio_can_resolve_epsg_codes_after_configuration() -> None:
    """The regression this shim exists for: a stale system PROJ_LIB makes
    every rasterio CRS lookup raise CRSError."""
    from rasterio.warp import transform_bounds

    minx, miny, maxx, maxy = transform_bounds("EPSG:4326", "EPSG:3857", 100, 30, 101, 31)
    assert 11_000_000 < minx < 11_300_000
    assert 3_400_000 < miny < 3_600_000
    assert maxx > minx
    assert maxy > miny
