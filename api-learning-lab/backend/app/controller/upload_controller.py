"""Controller for multipart file upload against a dataset."""
from fastapi import APIRouter, File, Form, Path, UploadFile

from app.service import file_service

router = APIRouter(prefix="/api/datasets", tags=["dataset-files"])


@router.post("/{dataset_id}/files", status_code=201)
async def upload_file(
    dataset_id: int = Path(..., description="Dataset this file belongs to"),
    file: UploadFile = File(..., description="The binary file being uploaded"),
    fileType: str | None = Form(None, alias="fileType", description="Optional override for the stored file_type"),
):
    """
    ================================
    Multipart Example

    URL:
        POST /api/datasets/{id}/files
        Content-Type: multipart/form-data

        Form fields:
            file      -> the binary file itself
            fileType  -> (optional) text field alongside the file

    Purpose:
        multipart/form-data is used for uploading files, binary data, and
        mixed form data (files + plain text fields) in the SAME request.
        A JSON body cannot carry raw binary bytes -- see
        docs/04-multipart-upload.md for why. The path parameter still
        does its usual job here: it says WHICH dataset the file attaches
        to.

    Database:
        INSERT INTO dataset_file (dataset_id, file_name, file_path,
                                   file_type, file_size, created_time)
        VALUES ({id}, ..., ..., ..., ..., now())
    ================================
    """
    return file_service.save_upload(dataset_id, file, fileType)


@router.get("/{dataset_id}/files")
def list_files(
    dataset_id: int = Path(..., description="Dataset to list files for"),
):
    """
    Read-only complement to the upload endpoint above, so you can verify
    an upload landed without going to look at the disk or the DB directly.

    Database:
        SELECT * FROM dataset_file WHERE dataset_id = {id}
    """
    return file_service.list_files(dataset_id)
