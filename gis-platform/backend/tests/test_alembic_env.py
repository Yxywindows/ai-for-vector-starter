"""Unit tests for `migrations/env.py`'s autogenerate scope.

`migrations/env.py` cannot be imported directly: like every Alembic env.py,
it runs a real migration as a side effect of module import (that's the
Alembic env.py contract -- `run_migrations_online()` is called unconditionally
at the bottom of the file). Driving autogenerate in-process against a real
engine just to test one predicate function is impractical here, so instead
this test extracts `include_object`'s function body directly from the
source file via `ast` and execs *only* that node -- exercising the exact
code that ships, not a hand-copied duplicate that could silently drift from
it -- and calls it with stub objects standing in for reflected tables in
each schema.
"""

from __future__ import annotations

import ast
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Protocol

from app.core.config import get_settings

ENV_PY_PATH = Path(__file__).resolve().parents[1] / "migrations" / "env.py"


class _IncludeObject(Protocol):
    def __call__(
        self, obj: Any, name: str, type_: str, reflected: bool, compare_to: Any
    ) -> bool: ...


def _load_include_object() -> _IncludeObject:
    source = ENV_PY_PATH.read_text()
    tree = ast.parse(source, filename=str(ENV_PY_PATH))
    func_node = next(
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "include_object"
    )
    isolated_module = ast.Module(body=[func_node], type_ignores=[])
    ast.fix_missing_locations(isolated_module)
    namespace: dict[str, Any] = {"settings": get_settings()}
    exec(compile(isolated_module, filename=str(ENV_PY_PATH), mode="exec"), namespace)
    include_object: _IncludeObject = namespace["include_object"]
    return include_object


def test_gis_data_tables_are_excluded_from_autogenerate() -> None:
    """The hazard this guards against: a reflected table in gis_data compared
    against an empty Base.metadata must never be admitted -- if it were,
    autogenerate would propose dropping it."""
    include_object = _load_include_object()
    imported_table = SimpleNamespace(schema="gis_data")

    assert include_object(imported_table, "some_imported_dataset", "table", True, None) is False


def test_gis_schema_tables_are_included() -> None:
    include_object = _load_include_object()
    platform_table = SimpleNamespace(schema="gis")

    assert include_object(platform_table, "layer", "table", False, None) is True
    assert include_object(platform_table, "project", "table", False, None) is True


def test_unrelated_schema_tables_are_excluded() -> None:
    """Anything that isn't the metadata schema is out of scope -- not just
    gis_data. `public`/`tiger`/etc. (postgis' own bundled tables) must never
    show up as autogenerate drift either."""
    include_object = _load_include_object()
    postgis_table = SimpleNamespace(schema="public")

    assert include_object(postgis_table, "spatial_ref_sys", "table", True, None) is False


def test_non_table_objects_are_never_filtered() -> None:
    """The predicate only narrows `type_ == "table"`; schemas, columns,
    indexes, etc. in any schema must pass through untouched."""
    include_object = _load_include_object()
    gis_data_schema_obj = SimpleNamespace(schema="gis_data")

    assert include_object(gis_data_schema_obj, "gis_data", "schema", False, None) is True
