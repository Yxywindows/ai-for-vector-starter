"""The only sanctioned way to put a user-supplied name into SQL.

Table and column names cannot be bind parameters, so they must be
interpolated. `validate_identifier` handles the common case -- a name
arriving directly on *this* request (a new table/column being created, a
`sortBy`/filter field typed into a query string) -- by accepting a
deliberately tiny grammar: lowercase ASCII, digits and underscore, max 63
characters, never starting with a digit. Anything else is rejected outright.

This is gate one of two for that case. Gate two is `catalog_service.
verify_source`, which confirms the name actually exists in the catalog.

`quote_catalog_name` is a second, narrower function for a different trust
boundary, and it is NOT belt-and-braces over already-trustworthy data: it is
the sole control on that path, so its escaping must be exactly right and
must never be weakened or "simplified" away.

The names it quotes were not typed into *this* request, but they were still
attacker-chosen, just earlier: a draft import (`ImportDraftRequest.
feature_collection` is `dict[str, Any]`) can carry a GeoJSON property key of
literally anything -- `geojson_validation._validate_properties` checks that
property *values* are JSON-serialisable, never that keys are safe
identifiers -- and `to_postgis` creates a column named verbatim after that
key. A property key of `evil" , (SELECT current_setting('x')) AS "y` lands
in `information_schema.columns` exactly as typed, attacker-chosen end to
end, and is read back out through `quote_catalog_name` on every later
attribute/tile read of that layer. The name has already passed through a
different gate by the time it gets here (`catalog_service.verify_source`
confirms it is a real, existing column, so it can't be an arbitrary string
smuggled in on *this* request), which is why `quote_catalog_name` does not
need `validate_identifier`'s character-set restriction -- but it absolutely
still needs correct SQL identifier quoting, because Postgres itself allows
that column to exist. The one thing standing between that stored name and a
second-order SQL injection is doubling an embedded `"`, exactly as Postgres
does: `quote_catalog_name` doing that correctly is not defense in depth, it
is the whole defense.
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

    NEVER call this on a name that arrived on the current request (a new
    table/column, a `sortBy`/filter field) -- use `validate_identifier`/
    `quote` for that. This function accepts any character Postgres itself
    would accept in a quoted identifier, including a mixed-case name
    `validate_identifier` would reject, because the input is not a fresh
    string from this request -- it is a name already sitting in
    `information_schema` for a table `catalog_service.verify_source` has
    confirmed exists. See the module docstring: that name can still be
    attacker-chosen (via a prior import), so the doubling escape below is
    load-bearing, not defense in depth -- it is the only thing standing
    between this value and a second-order SQL injection.
    """
    if not isinstance(name, str) or name == "":
        raise InvalidRequestError(
            "Invalid SQL identifier",
            details={"value": name if isinstance(name, str) else repr(name)},
        )
    return '"' + name.replace('"', '""') + '"'


def quote_list_catalog(names: Iterable[str]) -> str:
    """`quote_catalog_name`, joined for a SELECT list. Never on request input."""
    return ", ".join(quote_catalog_name(name) for name in names)
