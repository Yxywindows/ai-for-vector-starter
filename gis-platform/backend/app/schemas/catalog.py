from __future__ import annotations

from pydantic import Field

from app.schemas.base import APIModel

IDENT = Field(pattern=r"^[a-z_][a-z0-9_]{0,62}$")


class GeometryTableInfo(APIModel):
    schema_name: str
    table_name: str
    geometry_column: str
    srid: int
    geometry_type: str
    primary_key: str | None
    estimated_rows: int


class RegisterTableRequest(APIModel):
    schema_name: str = IDENT
    table_name: str = IDENT
    geometry_column: str = IDENT
    id_column: str = IDENT
    name: str = Field(min_length=1, max_length=200)


class ColumnInfo(APIModel):
    name: str
    data_type: str
    nullable: bool
    editable: bool
