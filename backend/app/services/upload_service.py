"""Streaming upload to disk, plus safe table-name derivation.

Uploads are never read fully into memory: a 2 GB GeoTIFF must not become a
2 GB bytes object. The size cap is enforced while streaming, so a hostile
client cannot fill the disk by lying about Content-Length.
"""

from __future__ import annotations

import re
import unicodedata
import uuid
from pathlib import Path

from fastapi import UploadFile

from app.core.errors import PayloadTooLargeError
from app.db.identifiers import validate_identifier

CHUNK_SIZE = 1024 * 1024
_NON_WORD = re.compile(r"[^a-z0-9]+")
_MAX_SLUG_BODY = 40


async def save_upload(upload: UploadFile, dest_dir: Path, max_bytes: int) -> Path:
    dest_dir.mkdir(parents=True, exist_ok=True)
    original = Path(upload.filename or "upload.bin").name  # strips any traversal
    suffix = "".join(Path(original).suffixes[-2:])  # keeps .shp.zip style pairs
    target = dest_dir / f"{uuid.uuid4().hex}{suffix or Path(original).suffix}"

    written = 0
    try:
        with target.open("wb") as sink:
            while chunk := await upload.read(CHUNK_SIZE):
                written += len(chunk)
                if written > max_bytes:
                    raise PayloadTooLargeError(
                        "Upload exceeds the configured size limit",
                        details={"maxBytes": max_bytes},
                    )
                sink.write(chunk)
    except Exception:
        target.unlink(missing_ok=True)
        raise
    return target


def slugify_table_name(filename: str) -> str:
    """Derive a guaranteed-valid, collision-free table name from a filename."""
    stem = Path(Path(filename).name).stem
    ascii_stem = unicodedata.normalize("NFKD", stem).encode("ascii", "ignore").decode()
    body = _NON_WORD.sub("_", ascii_stem.lower()).strip("_")[:_MAX_SLUG_BODY]
    if not body:
        body = "layer"
    if body[0].isdigit():
        body = f"t_{body}"
    return validate_identifier(f"{body}_{uuid.uuid4().hex[:8]}")
