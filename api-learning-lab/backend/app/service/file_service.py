"""
Service layer for multipart uploads: validates the parent dataset exists,
streams the file to disk, then records its metadata in `dataset_file`.
"""
import os
from pathlib import Path

from fastapi import HTTPException, UploadFile

from app.entity.dataset_file import dataset_file_to_api
from app.repository import dataset_file_repository, dataset_repository

UPLOAD_ROOT = Path(os.getenv("UPLOAD_DIR", "uploads"))


def save_upload(dataset_id: int, upload_file: UploadFile, file_type_override: str | None) -> dict:
    if dataset_repository.find_by_id(dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    dataset_dir = UPLOAD_ROOT / str(dataset_id)
    dataset_dir.mkdir(parents=True, exist_ok=True)

    dest_path = dataset_dir / upload_file.filename
    contents = upload_file.file.read()
    dest_path.write_bytes(contents)

    file_type = file_type_override or upload_file.content_type or "application/octet-stream"
    row = dataset_file_repository.create(
        dataset_id=dataset_id,
        file_name=upload_file.filename,
        file_path=str(dest_path).replace("\\", "/"),
        file_type=file_type,
        file_size=len(contents),
    )
    return dataset_file_to_api(row)


def list_files(dataset_id: int) -> list[dict]:
    if dataset_repository.find_by_id(dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    rows = dataset_file_repository.find_by_dataset_id(dataset_id)
    return [dataset_file_to_api(row) for row in rows]
