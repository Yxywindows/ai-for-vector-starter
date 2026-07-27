"""The only sanctioned way to put a user-supplied name into SQL.

Table and column names cannot be bind parameters, so they must be
interpolated. That is safe here only because `validate_identifier` accepts
a deliberately tiny grammar — lowercase ASCII, digits and underscore, max
63 characters, never starting with a digit. Anything else is rejected
outright rather than escaped, so there is no escaping bug to get wrong.

This is gate one of two. Gate two is `catalog_service.verify_source`,
which confirms the name actually exists in the catalog.
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from app.core.errors import InvalidRequestError

_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def validate_identifier(name: str) -> str:
    if not isinstance(name, str) or _IDENTIFIER.fullmatch(name) is None:
        raise InvalidRequestError(
            "Invalid SQL identifier",
            details={
                "value": name if isinstance(name, str) else repr(name),
                "expected": "lowercase letters, digits and underscore; 1-63 chars; "
                "must not start with a digit",
            },
        )
    return name


def quote(name: str) -> str:
    return f'"{validate_identifier(name)}"'


def qualified(schema: str, table: str) -> str:
    return f"{quote(schema)}.{quote(table)}"


def quote_list(names: Iterable[str]) -> str:
    return ", ".join(quote(name) for name in names)
