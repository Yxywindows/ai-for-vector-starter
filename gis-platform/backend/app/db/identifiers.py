"""The only sanctioned way to put a user-supplied name into SQL.

Table and column names cannot be bind parameters, so they must be
interpolated. That is safe here only because `validate_identifier` accepts
a deliberately tiny grammar — lowercase ASCII, digits and underscore, max
63 characters, never starting with a digit. Anything else is rejected
outright rather than escaped, so there is no escaping bug to get wrong.

This is gate one of two. Gate two is `catalog_service.verify_source`,
which confirms the name actually exists in the catalog.

`quote_catalog_name` is a second, deliberately narrower escape hatch for a
different trust boundary: a name that did not arrive on this request at all,
but was just read back from `information_schema` for a table this request
already resolved via `catalog_service.verify_source`. It was never a
candidate for injection -- whatever created that column (an import writer
using SQLAlchemy's own safe DDL quoting, e.g. an imported GeoJSON property
named "Name") already committed it to the catalog -- so there is nothing left
to validate except round-tripping it back into a double-quoted identifier
correctly, including a name Postgres allows but `validate_identifier` does
not (mixed case, mostly). Never call this on a name that came from request
input; use `validate_identifier`/`quote` for that.
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


def quote_catalog_name(name: str) -> str:
    """Quote a name already confirmed to exist in the database catalog.

    Escapes an embedded double quote by doubling it, exactly as Postgres
    itself does, instead of restricting the character set the way
    `validate_identifier` does -- see the module docstring for why that is
    safe here and not a general substitute for `validate_identifier`.
    """
    if not isinstance(name, str) or name == "":
        raise InvalidRequestError(
            "Invalid SQL identifier",
            details={"value": name if isinstance(name, str) else repr(name)},
        )
    return '"' + name.replace('"', '""') + '"'


def quote_list_catalog(names: Iterable[str]) -> str:
    return ", ".join(quote_catalog_name(name) for name in names)
