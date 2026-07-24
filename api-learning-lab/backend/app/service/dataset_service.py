"""
Service layer: business logic that sits between the controller (HTTP
concerns) and the repository (SQL). This is where "does this row exist"
and "translate camelCase API fields to snake_case DB columns" happen.
"""
import math

from fastapi import HTTPException

from app.entity.dataset import DatasetCreate, DatasetUpdate, dataset_to_api
from app.repository import dataset_repository

# API field (camelCase) -> DB column (snake_case). Used by update_dataset
# to turn "whatever the client sent" into a safe, explicit SET clause.
FIELD_TO_COLUMN = {
    "title": "title",
    "description": "description",
    "resourceType": "resource_type",
    "publishYear": "publish_year",
    "status": "status",
    "price": "price",
    "isPublic": "is_public",
    "tags": "tags",
    "metadata": "metadata",
    "location": "location",
}


def get_dataset(dataset_id: int) -> dict:
    row = dataset_repository.find_by_id(dataset_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
    return dataset_to_api(row)


def list_datasets(
    page: int,
    page_size: int,
    keyword: str | None,
    resource_type: str | None,
    year: int | None,
    status: str | None,
    sort_by: str,
    sort_order: str,
) -> dict:
    rows, total = dataset_repository.search(
        keyword=keyword,
        resource_type=resource_type,
        year=year,
        status=status,
        sort_by=sort_by,
        sort_order=sort_order,
        page=page,
        page_size=page_size,
    )
    return {
        "items": [dataset_to_api(row) for row in rows],
        "page": page,
        "pageSize": page_size,
        "total": total,
        "totalPages": math.ceil(total / page_size) if page_size else 0,
    }


def create_dataset(payload: DatasetCreate) -> dict:
    data = {
        "title": payload.title,
        "description": payload.description,
        "resource_type": payload.resourceType,
        "publish_year": payload.publishYear,
        "status": payload.status,
        "price": payload.price,
        "is_public": payload.isPublic,
        "tags": payload.tags,
        "metadata": payload.metadata,
        "location": payload.location,
    }
    row = dataset_repository.create(data)
    return dataset_to_api(row)


def update_dataset(dataset_id: int, payload: DatasetUpdate) -> dict:
    if dataset_repository.find_by_id(dataset_id) is None:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")

    # exclude_unset: only fields actually present in the JSON body are
    # included — a field the client omitted is left untouched in the DB.
    provided = payload.model_dump(exclude_unset=True)
    fields = {FIELD_TO_COLUMN[api_field]: value for api_field, value in provided.items()}

    row = dataset_repository.update(dataset_id, fields)
    return dataset_to_api(row)


def delete_dataset(dataset_id: int) -> None:
    deleted = dataset_repository.delete(dataset_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Dataset {dataset_id} not found")
