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

## Filtering without string-building

The attribute table (`GET /layers/{layerId}/attributes`) is where this
module's dynamic-SQL surface gets widest. A bbox feature read only ever
substitutes names the *server* already knows from the layer's own
`PostgisSource` — geometry column, id column, schema, table. The attribute
table additionally takes a **sort column** and a set of **filter
field/operator/value triples** straight from the query string, and all of
them end up in `ORDER BY` and `WHERE`. Three user-controlled inputs, not
one, each reaching SQL text.

The filter side needs its own three-part rule, because a filter is three
separate pieces of untrusted input glued together — a field name, an
operator, and a value — and each piece fails differently if left
unchecked:

```python
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
```

`in` binds its list as-is rather than casting the column and stringifying
the values. An earlier revision of this code cast both sides to `text` on
the theory that asyncpg needed help typing the array; that theory doesn't
hold up against what Postgres actually does. Preparing the same shape of
query this function builds and asking Postgres what type it inferred for
the array parameter, for three differently-typed columns:

```
population = ANY($1) param type: int4[]
density    = ANY($1) param type: numeric[]
label      = ANY($1) param type: text[]
```

Postgres infers the array's element type from `{col}`, the left operand of
`= ANY(...)`, not from some fixed default — so no per-type cast was ever
needed. Worse, the `::text` cast was actively wrong: Postgres's own `::text`
rendering of a value and Python's `str()` of the same value disagree for
`float`, `numeric`, and `bool` (`1.0::text` is `'1'`, `str(1.0)` is
`"1.0"`; `0.50::numeric(10,2)::text` is `'0.50'`, `str(0.5)` is `"0.5"`),
so `{col}::text = ANY(:p)` with Python-stringified values silently matched
nothing for those types instead of raising. Binding `item.value` unchanged
is both simpler and correct — confirmed against text, integer,
`double precision`, and `numeric` columns, all four returning the right
rows with no cast on either side (`test_in_filter_accepts_a_list`,
`test_in_filter_works_on_a_numeric_column`,
`test_in_filter_works_on_a_float_and_a_numeric_column` in
`tests/test_attributes_api.py`).

And the function that turns a list of client-supplied filters into a
`WHERE` clause plus its bind parameters:

```python
def build_where(filters: list[AttributeFilter], allowed: set[str]) -> tuple[str, dict[str, Any]]:
    """Compose a WHERE clause from validated fields and bound values.

    The field name is validated twice — against the set of columns that
    actually exist on this table, and against the identifier allowlist
    regex (via `quote`/`validate_identifier`) when it is spliced into the
    clause — and the operator can only be one of the fixed keys of
    OPERATOR_SQL. The value is always a bind parameter, never text.
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}
    for index, item in enumerate(filters):
        if item.field not in allowed:
            raise InvalidRequestError(
                "Unknown filter field",
                details={"field": item.field, "allowed": sorted(allowed)},
            )
        template = OPERATOR_SQL[item.op]
        placeholder = f"f{index}"
        clauses.append(template.format(col=quote(validate_identifier(item.field)), p=placeholder))
        if item.op not in VALUELESS_OPS:
            if item.op == "in":
                if not isinstance(item.value, list) or not item.value:
                    raise InvalidRequestError(
                        "The 'in' operator needs a non-empty list",
                        details={"field": item.field},
                    )
                params[placeholder] = item.value
            else:
                params[placeholder] = item.value
    return (" AND ".join(clauses) if clauses else "TRUE"), params
```

Three checks, each covering a piece bind parameters cannot cover on their
own:

- **The field** is checked against `allowed` — the live column list read
  from the catalog for *this* table (`feature_repository.attribute_columns`,
  itself backed by `catalog_repository.list_columns`) — before it is
  allowed anywhere near SQL text. This is gate two again, specialised to
  "does this column exist," not just "does this table exist": a
  syntactically valid identifier that simply isn't a column on this table
  (`nope`, or a column that belongs to some other table entirely) is
  rejected here, the same way `verify_source` rejects a table that doesn't
  exist. The identifier still passes through `validate_identifier` via
  `quote()` when the clause is built, so both gates run — the catalog
  check and the grammar check — not just one.
- **The operator** can only be a key of `OPERATOR_SQL`. `AttributeFilter.op`
  is typed as the `FilterOp` `Literal`, so Pydantic itself refuses any
  string that isn't one of the eleven named operators before `build_where`
  ever sees it — `op="regex"` fails validation at the schema boundary, not
  as a SQL error. Nothing about the operator is ever formatted from a raw
  string; `template = OPERATOR_SQL[item.op]` is a dict lookup, not string
  interpolation, so there is no way for a value to be smuggled in through
  the operator position either.
- **The value** is always `params[placeholder]` — a bind parameter, never
  text. Even `in`, which binds a *list*, still binds it: `item.value` is
  passed to `= ANY(:{p})` unchanged, with Postgres inferring the bound
  array's element type from `{col}` on the left, so the same bind works for
  a text column, an integer column, or a `numeric` column without this
  function needing to know which. Nothing about the value is ever
  concatenated into the SQL string, for any operator.

`sortBy` gets the same treatment, just without the operator dimension.
`attribute_service.get_page` checks the requested sort column against the
same live column list before it ever reaches the repository:

```python
    effective_sort = sort_by or source.id_column
    if effective_sort not in columns:
        raise InvalidRequestError(
            "Unknown sort column", details={"sortBy": effective_sort, "allowed": columns}
        )
```

so `population; DROP TABLE gis.layer` is rejected the moment it fails that
membership check — it never reaches `feature_repository.read_attribute_page`,
whose own `quote(validate_identifier(sort_by))` would reject it a second
time regardless. Two independent gates, either one of which is sufficient
on its own; the test proves it by checking not just the response but that
the attack had no effect:

```python
async def test_sort_by_injection_attempt_is_rejected(
    client: AsyncClient, cities_layer: dict
) -> None:
    response = await client.get(
        f"/api/v1/layers/{cities_layer['id']}/attributes",
        params={"sortBy": "population; DROP TABLE gis.layer"},
    )
    assert response.status_code == 422
    assert (await client.get("/api/v1/projects")).status_code == 200
```

The second assertion is the one that matters. A 422 alone only proves the
request failed *somehow* — it would pass just as well against a broken
implementation that 422'd for an unrelated reason while still running the
injected SQL, or one that silently swallowed the `DROP TABLE`. Following it
with a request that only succeeds if `gis.layer` still exists (`GET
/api/v1/projects` reads that table to count each project's layers) turns
"the server said no" into "the attack demonstrably did not happen."
