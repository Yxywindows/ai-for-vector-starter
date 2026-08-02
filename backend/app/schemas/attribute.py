from __future__ import annotations

import json
from typing import Any, Literal, Self

from pydantic import Field, ValidationError

from app.core.errors import InvalidRequestError
from app.schemas.base import APIModel
from app.schemas.catalog import ColumnInfo

FilterOp = Literal[
    "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "isnull", "notnull"
]

# op -> SQL fragment template. `{col}` is a validated identifier; `:p` is a bind.
OPERATOR_SQL: dict[str, str] = {
    "eq": "{col} = :{p}",
    "neq": "{col} IS DISTINCT FROM :{p}",
    "gt": "{col} > :{p}",
    "gte": "{col} >= :{p}",
    "lt": "{col} < :{p}",
    "lte": "{col} <= :{p}",
    "like": "{col}::text LIKE :{p}",
    "ilike": "{col}::text ILIKE :{p}",
    "in": "{col} = ANY(:{p})",
    "isnull": "{col} IS NULL",
    "notnull": "{col} IS NOT NULL",
}

VALUELESS_OPS = {"isnull", "notnull"}


class AttributeFilter(APIModel):
    field: str = Field(min_length=1)
    op: FilterOp
    value: Any = None

    @classmethod
    def parse_list(cls, raw: str | None) -> list[Self]:
        if not raw:
            return []
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise InvalidRequestError(
                "filters must be a JSON array", details={"filters": raw}
            ) from exc
        if not isinstance(payload, list):
            raise InvalidRequestError("filters must be a JSON array", details={"filters": raw})
        try:
            return [cls.model_validate(item) for item in payload]
        except ValidationError as exc:
            raise InvalidRequestError("Invalid filter", details={"errors": exc.errors()}) from exc


class FieldList(APIModel):
    fields: list[ColumnInfo]
    id_column: str
    geometry_column: str


class AttributePage(APIModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    page: int
    page_size: int
    total: int
    # True when `total` is the planner's estimate rather than an exact
    # count -- the unfiltered fast path over large tables.
    total_estimated: bool = False
