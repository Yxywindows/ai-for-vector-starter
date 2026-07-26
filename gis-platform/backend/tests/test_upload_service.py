import io
from pathlib import Path

import pytest
from fastapi import UploadFile

from app.core.errors import PayloadTooLargeError
from app.db.identifiers import validate_identifier
from app.services.upload_service import save_upload, slugify_table_name


def _upload(name: str, payload: bytes) -> UploadFile:
    return UploadFile(filename=name, file=io.BytesIO(payload))


async def test_save_upload_writes_bytes_and_keeps_the_extension(tmp_path: Path) -> None:
    path = await save_upload(_upload("cities.geojson", b"{}"), tmp_path, max_bytes=1024)
    assert path.parent == tmp_path
    assert path.suffix == ".geojson"
    assert path.read_bytes() == b"{}"


async def test_save_upload_rejects_oversize_payloads_before_finishing(tmp_path: Path) -> None:
    with pytest.raises(PayloadTooLargeError):
        await save_upload(_upload("big.geojson", b"x" * 5000), tmp_path, max_bytes=1024)
    assert list(tmp_path.iterdir()) == []  # partial file is cleaned up


async def test_save_upload_rejects_a_traversal_filename(tmp_path: Path) -> None:
    path = await save_upload(_upload("../../evil.geojson", b"{}"), tmp_path, max_bytes=1024)
    assert path.parent == tmp_path
    assert ".." not in path.name


@pytest.mark.parametrize(
    ("filename", "prefix"),
    [
        ("Cities of China.geojson", "cities_of_china_"),
        ("2024-roads.zip", "t_2024_roads_"),
        ("café.gpkg", "cafe_"),
    ],
)
def test_slugify_produces_a_valid_unique_identifier(filename: str, prefix: str) -> None:
    name = slugify_table_name(filename)
    assert validate_identifier(name) == name
    assert name.startswith(prefix)
    assert name != slugify_table_name(filename)  # uuid suffix makes it unique


def test_slugify_truncates_long_names() -> None:
    name = slugify_table_name("a" * 200 + ".geojson")
    assert len(name) <= 63
    assert validate_identifier(name) == name
