"""
Repository layer: the ONLY place raw SQL is written for the `dataset`
table. Every method below is one readable, parameterized query — this is
where a query/path parameter turns directly into a WHERE/SET clause.
"""
import json

from app.db import get_cursor

# Whitelist of API sort keys -> real DB columns. Never interpolate a
# caller-supplied column name straight into SQL (that's how you get SQL
# injection via ORDER BY) — always go through a mapping like this one.
SORTABLE_COLUMNS = {
    "id": "id",
    "title": "title",
    "publishYear": "publish_year",
    "status": "status",
    "price": "price",
    "createdTime": "created_time",
    "updatedTime": "updated_time",
}


def find_by_id(dataset_id: int) -> dict | None:
    with get_cursor() as cur:
        cur.execute("SELECT * FROM dataset WHERE id = %s", (dataset_id,))
        return cur.fetchone()


def search(
    keyword: str | None,
    resource_type: str | None,
    year: int | None,
    status: str | None,
    sort_by: str,
    sort_order: str,
    page: int,
    page_size: int,
) -> tuple[list[dict], int]:
    """
    Builds a dynamic WHERE clause from whichever filters were actually
    supplied. Every condition is optional and independent:
      keyword       -> title ILIKE '%...%'   (fuzzy search)
      resource_type -> resource_type = ...   (exact match)
      year          -> publish_year = ...    (exact match)
      status        -> status = ...          (exact match)
    """
    where_clauses = []
    params: list = []

    if keyword:
        where_clauses.append("title ILIKE %s")
        params.append(f"%{keyword}%")
    if resource_type:
        where_clauses.append("resource_type = %s")
        params.append(resource_type)
    if year is not None:
        where_clauses.append("publish_year = %s")
        params.append(year)
    if status:
        where_clauses.append("status = %s")
        params.append(status)

    where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
    sort_column = SORTABLE_COLUMNS.get(sort_by, "created_time")
    sort_direction = "ASC" if sort_order == "asc" else "DESC"
    offset = (page - 1) * page_size

    with get_cursor() as cur:
        cur.execute(f"SELECT COUNT(*) AS total FROM dataset {where_sql}", params)
        total = cur.fetchone()["total"]

        cur.execute(
            f"""
            SELECT * FROM dataset
            {where_sql}
            ORDER BY {sort_column} {sort_direction}
            LIMIT %s OFFSET %s
            """,
            params + [page_size, offset],
        )
        rows = cur.fetchall()

    return rows, total


def create(data: dict) -> dict:
    with get_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO dataset
                (title, description, resource_type, publish_year, status,
                 price, is_public, tags, metadata, location, created_time, updated_time)
            VALUES
                (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb, now(), now())
            RETURNING *
            """,
            (
                data["title"],
                data["description"],
                data["resource_type"],
                data["publish_year"],
                data["status"],
                data["price"],
                data["is_public"],
                json.dumps(data["tags"]),
                json.dumps(data["metadata"]),
                json.dumps(data["location"]),
            ),
        )
        return cur.fetchone()


def update(dataset_id: int, fields: dict) -> dict | None:
    """
    `fields` is a dict of {column_name: new_value} for only the columns
    that should change — built by the service layer from whichever keys
    were present in the PUT body. This is the "path says WHICH row, body
    says WHAT changes" pattern turned into one UPDATE statement.
    """
    if not fields:
        return find_by_id(dataset_id)

    set_clauses = []
    params: list = []
    for column, value in fields.items():
        if column in ("tags", "metadata", "location"):
            set_clauses.append(f"{column} = %s::jsonb")
            params.append(json.dumps(value))
        else:
            set_clauses.append(f"{column} = %s")
            params.append(value)
    set_clauses.append("updated_time = now()")
    params.append(dataset_id)

    with get_cursor(commit=True) as cur:
        cur.execute(
            f"UPDATE dataset SET {', '.join(set_clauses)} WHERE id = %s RETURNING *",
            params,
        )
        return cur.fetchone()


def delete(dataset_id: int) -> bool:
    with get_cursor(commit=True) as cur:
        cur.execute("DELETE FROM dataset WHERE id = %s", (dataset_id,))
        return cur.rowcount > 0
