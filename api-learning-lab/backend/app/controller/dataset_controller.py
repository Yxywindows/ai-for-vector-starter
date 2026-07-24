"""
Controller layer: HTTP concerns only. Each function reads path / query /
header / body input, hands it to the service layer, and returns a plain
dict (FastAPI serializes it to JSON). No SQL lives here.
"""
from fastapi import APIRouter, Depends, Path, Query, Response

from app.auth import RequestContext, require_auth
from app.entity.dataset import DatasetCreate, DatasetUpdate
from app.service import dataset_service

router = APIRouter(prefix="/api/datasets", tags=["datasets"])


@router.get("/{dataset_id}")
def get_dataset(
    dataset_id: int = Path(..., description="Primary key of the dataset row"),
):
    """
    ================================
    Path Parameter Example

    URL:
        GET /api/datasets/{id}

    Purpose:
        Identify ONE specific resource. The path parameter is part of the
        URL itself (not a suffix like ?id=), which is the REST convention
        for "which resource" as opposed to "which conditions".

    Database:
        SELECT * FROM dataset WHERE id = {id}
    ================================
    """
    return dataset_service.get_dataset(dataset_id)


@router.get("")
def list_datasets(
    page: int = Query(1, ge=1, description="1-based page number"),
    pageSize: int = Query(10, ge=1, le=100, alias="pageSize"),
    keyword: str | None = Query(None, description="Fuzzy match on title"),
    type_: str | None = Query(None, alias="type", description="Exact match on resourceType"),
    year: int | None = Query(None, description="Exact match on publishYear"),
    status: str | None = Query(None, description="Exact match on status"),
    sortBy: str = Query("createdTime", alias="sortBy"),
    sortOrder: str = Query("desc", alias="sortOrder"),
):
    """
    ================================
    Query Parameter Example

    URL:
        GET /api/datasets?page=1&pageSize=10&keyword=ocean&type=weather&year=2023&status=published

    Purpose:
        Query parameters filter, search, paginate and sort a COLLECTION.
        Unlike a path parameter, each one is optional and independent —
        you can supply any subset of them.

    Database:
        keyword -> WHERE title ILIKE '%keyword%'   (fuzzy search)
        type    -> WHERE resource_type = 'type'    (exact match)
        year    -> WHERE publish_year = year        (exact match)
        status  -> WHERE status = 'status'          (exact match)
        page/pageSize -> LIMIT pageSize OFFSET (page-1)*pageSize
    ================================
    """
    sort_order = sortOrder.lower() if sortOrder.lower() in ("asc", "desc") else "desc"
    return dataset_service.list_datasets(
        page=page,
        page_size=pageSize,
        keyword=keyword,
        resource_type=type_,
        year=year,
        status=status,
        sort_by=sortBy,
        sort_order=sort_order,
    )


@router.post("", status_code=201)
def create_dataset(
    payload: DatasetCreate,
    ctx: RequestContext = Depends(require_auth),
):
    """
    ================================
    Request Body Example  (+ Header Example)

    URL:
        POST /api/datasets
        Headers: Authorization: Bearer <token>, X-Organization-ID: <id>
        Body:    {"title": "...", "description": "...",
                  "resourceType": "...", "metadata": {...}}

    Purpose:
        The BODY contains the data submitted to the server — the new
        resource itself. The HEADERS separately answer "who is making
        this request", never "what should be created". `ctx.token` /
        `ctx.organization_id` are only echoed back below for you to
        observe; they never influence which row gets inserted.

    Database:
        INSERT INTO dataset (title, description, resource_type, ...)
        VALUES (...)
    ================================
    """
    result = dataset_service.create_dataset(payload)
    result["createdBy"] = ctx.token
    result["organizationId"] = ctx.organization_id
    return result


@router.put("/{dataset_id}")
def update_dataset(
    payload: DatasetUpdate,
    dataset_id: int = Path(..., description="Which dataset to update"),
    ctx: RequestContext = Depends(require_auth),
):
    """
    ================================
    Update Example: Path + Body together

    URL:
        PUT /api/datasets/{id}
        Body: {"status": "published", "price": 99.00}

    Purpose:
        The PATH parameter says WHICH resource to update; the BODY says
        WHAT should change on it. Neither one is enough alone — an id
        with no body doesn't tell you what to change, and a body with
        no id doesn't tell you which row. Only fields present in the
        JSON body are modified; everything else on the row is untouched
        (see dataset_service.update_dataset's use of exclude_unset).

    Database:
        UPDATE dataset SET status = 'published', price = 99.00,
                           updated_time = now()
        WHERE id = {id}
    ================================
    """
    result = dataset_service.update_dataset(dataset_id, payload)
    result["updatedBy"] = ctx.token
    return result


@router.delete("/{dataset_id}", status_code=204)
def delete_dataset(
    dataset_id: int = Path(..., description="Which dataset to delete"),
    ctx: RequestContext = Depends(require_auth),
):
    """
    ================================
    Delete Example: Path only

    URL:
        DELETE /api/datasets/{id}

    Purpose:
        Deletion only ever needs to know WHICH resource — there's no
        body, because there's no new data to submit. Requires the same
        auth headers as create/update since it's also a write operation.

    Database:
        DELETE FROM dataset WHERE id = {id}
    ================================
    """
    dataset_service.delete_dataset(dataset_id)
    return Response(status_code=204)
