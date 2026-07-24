"""
Entity layer: the shape of data going in (request bodies) and the mapping
of data coming out (DB row -> API field).

This is where the "Database field <-> API field" translation lives:
DB column `resource_type` (snake_case, SQL convention) becomes API field
`resourceType` (camelCase, JSON convention). Nothing else in the app
should need to know both names.
"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class DatasetCreate(BaseModel):
    """
    # ================================
    # Request Body Example
    #
    # This model IS the request body contract for:
    #   POST /api/datasets
    #
    # The body contains the data submitted to the server — as opposed to
    # headers (who's asking) or query params (which subset to read).
    # ================================
    """
    title: str
    description: Optional[str] = None
    resourceType: str
    publishYear: Optional[int] = None
    status: str = "draft"
    price: float = 0
    isPublic: bool = True
    tags: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)
    location: dict[str, Any] = Field(default_factory=dict)


class DatasetUpdate(BaseModel):
    """
    Request body for PUT /api/datasets/{id}.

    Every field is optional: a field left out of the JSON body means
    "leave this column unchanged". The path parameter says WHICH row to
    touch; this body says WHAT changes on it. See dataset_controller.py
    for how the two are combined into one UPDATE statement.
    """
    title: Optional[str] = None
    description: Optional[str] = None
    resourceType: Optional[str] = None
    publishYear: Optional[int] = None
    status: Optional[str] = None
    price: Optional[float] = None
    isPublic: Optional[bool] = None
    tags: Optional[list[str]] = None
    metadata: Optional[dict[str, Any]] = None
    location: Optional[dict[str, Any]] = None


def dataset_to_api(row: dict) -> dict:
    """Map one `dataset` DB row (snake_case) to the API's camelCase shape."""
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "resourceType": row["resource_type"],
        "publishYear": row["publish_year"],
        "status": row["status"],
        "price": float(row["price"]) if row["price"] is not None else None,
        "isPublic": row["is_public"],
        "tags": row["tags"],
        "metadata": row["metadata"],
        "location": row["location"],
        "createdTime": row["created_time"].isoformat() if row["created_time"] else None,
        "updatedTime": row["updated_time"].isoformat() if row["updated_time"] else None,
        "fileSize": row["file_size"],
    }
