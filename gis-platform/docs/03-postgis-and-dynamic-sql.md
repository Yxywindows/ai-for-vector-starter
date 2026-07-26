# 03 · PostGIS and Dynamic SQL

Every other backend module in this project can declare its tables up front —
`gis.project` and `gis.layer` (`02-spatial-data-model.md`) have a fixed shape
the ORM knows about at import time. This module cannot. A layer's data lives
in a table this application did not create and does not control the shape
of: an existing `gis_data` import, or a user's own schema registered in
place. The *name* of that table — which schema, which table, which geometry
column, which id column — only exists as a string that arrived over HTTP.
Every later feature (feature reads, attribute tables, vector tiles, editing)
has to run real SQL against that table, so this module has to answer one
question safely, over and over: how do you put an attacker-controlled string
into a SQL statement without giving the attacker a SQL statement of their
own?

## Why bind parameters are not enough

The usual answer to "untrusted value in SQL" is a bind parameter — and for
*values* (a number in a `WHERE` clause, a string in an `INSERT`), that's the
whole answer, no further discussion needed. It does not work here because a
table or column name is not a value. This is not valid SQL:

```sql
SELECT * FROM :table
```

Postgres's parameter binding only fills in places where an expression is
expected — literals, not identifiers. There's no protocol-level mechanism
for "bind this string as a table name." A schema-qualified table name has to
be spliced into the SQL text as text, which means the interpolation itself
is exactly where SQL injection lives: naively write
`f"SELECT * FROM {schema}.{table}"` and a table name of
`test_cities; DROP TABLE gis.layer` is now Postgres's problem, not the
attacker's.

The rule this whole module exists to enforce: **a SQL identifier that came
from user input may only reach a query after passing `validate_identifier()`
and being confirmed to exist in the catalog. Values are always bind
parameters. There are no exceptions.**

## Gate one: an allowlist grammar

`app/db/identifiers.py` is the only place in the codebase allowed to turn a
string into part of a SQL statement's identifier position:

```python
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
```

The important design decision here is **reject, don't escape**. A tempting
alternative is to accept any string and neutralize the dangerous characters
— double a `"` inside a quoted identifier, escape a `;`, and so on. That
approach has a long, ongoing history of getting subtly wrong: a missed
character class, an encoding edge case, a code path that quotes with `'`
instead of `"`. `validate_identifier` sidesteps the entire problem by making
the accepted grammar so small that there is no escaping logic to write in
the first place — lowercase ASCII letters, digits, and underscore, 1–63
characters, never starting with a digit. Anything outside that grammar is
refused outright, including a name that is a *legitimate* identifier in some
other dialect or encoding (`café`, `Roads`, a 64-character name). Every
caller composing SQL text — `quote`, `qualified`, `quote_list` — routes
through `validate_identifier` first, so there is exactly one function in the
codebase that decides whether a string is safe to interpolate.

The parametrised rejection test is the evidence that the grammar actually
rejects what it should:

```python
@pytest.mark.parametrize(
    "name",
    [
        "",
        "1roads",
        "Roads",
        "roads;DROP TABLE gis.layer",
        'roads" OR "1"="1',
        "roads-2",
        "roads table",
        "x" * 64,
        "café",
    ],
)
def test_rejects_anything_else(name: str) -> None:
    with pytest.raises(InvalidRequestError):
        validate_identifier(name)
```

That list is not decorative — `roads;DROP TABLE gis.layer` and
`roads" OR "1"="1` are exactly the shapes a real attacker would try, sitting
next to the more mundane rejections (wrong case, wrong length, wrong
encoding) so the grammar can't be "fixed" into passing the injection cases
by accident while chasing an unrelated bug.

## Gate two: catalog existence

The regex is necessary but not sufficient. `roads_that_do_not_exist` passes
`validate_identifier` just as easily as `roads` does — the grammar has no
way to know what tables actually exist. Gate two, `catalog_service.
verify_source`, closes that gap by checking the validated name against the
real Postgres catalog before any dynamic SQL runs against it:

```python
async def verify_source(session: AsyncSession, source: PostgisSource) -> None:
    """Gate two: the validated names must actually name a real table and columns.

    Called by every service that runs dynamic SQL against a layer's table, so
    a layer whose table was dropped fails with 404 instead of a SQL error.
    """
    if not await catalog_repository.table_exists(session, source.schema_name, source.table_name):
        raise NotFoundError(
            f"Table {source.schema_name}.{source.table_name} does not exist",
            details={"schemaName": source.schema_name, "tableName": source.table_name},
        )
    columns = {
        column.name
        for column in await catalog_repository.list_columns(
            session, source.schema_name, source.table_name
        )
    }
    missing = {source.geometry_column, source.id_column} - columns
    if missing:
        raise NotFoundError(
            "Column not found on table",
            details={
                "schemaName": source.schema_name,
                "tableName": source.table_name,
                "missing": sorted(missing),
            },
        )
```

Two things fall out of this. First, a layer whose backing table was later
dropped or renamed — which `PostgisSource` on its own has no way to detect,
since the Pydantic model only validates *shape*, not existence — now fails
with a clean 404 instead of a raw `UndefinedTable` error bubbling out of
asyncpg. Second, and this is the case that actually matters for injection: a
name that is grammatically a valid identifier but names nothing real (or
names something the request has no business touching) is blocked here, one
layer before any SQL text gets built from it. Every service in this codebase
that runs dynamic SQL against a layer's table — attribute reads, tile
generation, editing, all in later tasks — calls `verify_source` first.

## Reading the catalog

`GET /connections/postgis/tables` lists every geometry-bearing table the
database knows about, so the frontend can offer "register an existing
table" as a real dropdown instead of asking a user to type a table name
blind:

```sql
    SELECT g.f_table_schema  AS schema_name,
           g.f_table_name    AS table_name,
           g.f_geometry_column AS geometry_column,
           g.srid            AS srid,
           g.type            AS geometry_type,
           COALESCE(c.reltuples, 0)::bigint AS estimated_rows
    FROM geometry_columns g
    LEFT JOIN pg_class c
           ON c.oid = to_regclass(quote_ident(g.f_table_schema) || '.'
                                  || quote_ident(g.f_table_name))
    WHERE g.f_table_schema <> ALL(:hidden)
    ORDER BY g.f_table_schema, g.f_table_name
```

Three pieces of PostGIS/Postgres machinery are doing the real work:

- **`geometry_columns`** is a PostGIS-provided view, not a table this
  application owns. It already enumerates every column in the database that
  PostGIS knows carries geometry, with its schema, table, column name, SRID
  and geometry type — so this query is a filter over PostGIS's own
  bookkeeping, not a hand-rolled scan of `information_schema`. `WHERE
  g.f_table_schema <> ALL(:hidden)` filters out PostGIS's own internal
  schemas (`topology`, `tiger`, `tiger_data`) and Postgres's own
  (`pg_catalog`, `information_schema`) — `:hidden` here is a *value* (an
  array of schema names to exclude), not an identifier, so it's an ordinary
  bind parameter, no `validate_identifier` involved.
- **`to_regclass`** turns a qualified name into that table's OID, or `NULL`
  if no such table exists — critically, it *returns NULL* rather than
  raising an error for an unknown name. That makes it safe to call
  speculatively (as gate two does in `table_exists`, and as this query does
  to join `pg_class` for row estimates) without wrapping every call in
  exception handling for the "doesn't exist" case.
- **`pg_class.reltuples`** is Postgres's own row-count estimate for a table,
  maintained by `ANALYZE`/autovacuum — not a live `count(*)`, which is why
  the field is named `estimatedRows` on the wire rather than `rowCount`. A
  table that has never been analyzed (freshly created, no autovacuum run
  yet) reports `-1` as a sentinel for "unknown," not `0` — `list_geometry_tables`
  clamps that to `0` (`max(int(row["estimated_rows"]), 0)`) so the API never
  hands the frontend a negative row count.

## Finding the primary key

```sql
    SELECT a.attname AS name
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
    WHERE i.indrelid = to_regclass(:qname) AND i.indisprimary
    ORDER BY a.attnum
    LIMIT 1
```

This reads the primary-key column straight from Postgres's own index
catalog (`pg_index`/`pg_attribute`) rather than trusting a client-supplied
`idColumn` at face value. Editing a feature (a later task) has to identify
*which row* an update or delete targets, and the only column guaranteed to
pick out exactly one row, forever, is a real primary key — a table with no
primary key, or a composite one, can't safely back single-row edits through
this API. `LIMIT 1` after `ORDER BY a.attnum` deliberately returns the first
column of a composite key rather than erroring, since read-only registration
(listing tables, computing extent/count) doesn't need a *unique* key, only
*a* stable one to order by; edit-capable registration is where a composite
or missing key becomes a hard error, in a later task.

## Extent and count

```python
async def compute_extent_4326(session: AsyncSession, source: PostgisSource) -> list[float] | None:
    """Bounding box in EPSG:4326, or None for an empty / all-null table."""
    sql = text(
        f"""
        SELECT ST_XMin(box) AS minx, ST_YMin(box) AS miny,
               ST_XMax(box) AS maxx, ST_YMax(box) AS maxy
        FROM (
            SELECT ST_Extent(ST_Transform({quote(source.geometry_column)}, 4326)) AS box
            FROM {qualified(source.schema_name, source.table_name)}
        ) AS extent
        """
    )
    row = (await session.execute(sql)).mappings().one()
    if row["minx"] is None:
        return None
    return [float(row["minx"]), float(row["miny"]), float(row["maxx"]), float(row["maxy"])]
```

`{quote(source.geometry_column)}` and `{qualified(source.schema_name,
source.table_name)}` are the only interpolated pieces of this statement, and
both go through `quote`/`qualified` — meaning both have already been through
`validate_identifier`, and by the time this function runs, `verify_source`
has already confirmed the table and column are real. Nothing else in the
statement is built from user input: `4326` is a literal, not a parameter,
because it is never anything other than the wire SRID.

`ST_Transform(..., 4326)` is doing real work, not defensive boilerplate.
Global Constraints fix the *wire* format at EPSG:4326 for every extent,
bbox, and GeoJSON coordinate this API returns — but the *storage* SRID of a
registered table is whatever that table declares (`source.srid`, read from
`geometry_columns` in `catalog_service.register_table`), which for a
user-registered table could be a state-plane or UTM projection with
coordinate values that mean nothing plotted directly on a web map.
`ST_Extent` alone would return a bounding box in *storage* coordinates;
transforming first means the extent this function returns is always
directly usable as a Leaflet/OpenLayers `fitBounds`-style argument,
regardless of what SRID the table was stored in.

The `None` case matters as much as the happy path: `ST_Extent` over zero
rows, or over rows whose geometry column is entirely `NULL`, aggregates to
SQL `NULL`, and `ST_XMin(NULL)` is `NULL` too — so `row["minx"] is None`
is the real, tested signal for "this table has no computable extent," not a
guess. An empty or all-NULL table is a legitimate state (a table just
registered before any features were imported into it), not an error, so
this function returns `None` for the frontend to treat as "no extent yet"
rather than raising and turning a valid registration into a 500.

## The rule

Every dynamic query in this codebase, present and future, follows the same
three-part shape: **a validated identifier (`validate_identifier`, gate
one) + a catalog check that it actually exists (`verify_source`, gate two)
+ bind parameters for every value that isn't an identifier.** No function
anywhere is allowed to skip a step because "this one case is safe" — the
whole point of collapsing identifier safety into two small, always-called
gates is that no later chapter has to re-derive whether its particular
dynamic query is the exception. If a later chapter writes SQL against a
layer's table, it calls `verify_source` first and builds identifiers with
`quote`/`qualified`/`quote_list`, full stop.
