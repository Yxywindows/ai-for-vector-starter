"""Wire models for the staged import.

`ImportResult` carries `rejected_count` and `errors` even though a 201 always
has them empty: import is all-or-nothing, and a caller should not have to know
that rule to read the response. On a rejection there is no ImportResult at all
-- the issues travel in the error envelope as `details.errors`, in this same
FeatureIssue shape.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from app.schemas.base import APIModel
from app.schemas.layer import LayerRead
from app.services.geojson_validation import Issue


class ImportDraftRequest(APIModel):
    name: str = Field(min_length=1, max_length=200)
    source_filename: str = Field(min_length=1, max_length=255)
    feature_collection: dict[str, Any]


class FeatureIssue(APIModel):
    feature_index: int
    field: str | None
    code: str
    message: str

    @classmethod
    def of(cls, issue: Issue) -> FeatureIssue:
        return cls(
            feature_index=issue.feature_index,
            field=issue.field,
            code=issue.code,
            message=issue.message,
        )


class ImportResult(APIModel):
    layer: LayerRead
    imported_count: int
    rejected_count: int
    warning_count: int
    errors: list[FeatureIssue]
    warnings: list[FeatureIssue]
