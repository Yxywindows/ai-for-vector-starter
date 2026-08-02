import pytest

from app.core.errors import InvalidRequestError
from app.db.identifiers import (
    qualified,
    quote,
    quote_catalog_name,
    quote_list,
    quote_list_catalog,
    validate_identifier,
)


@pytest.mark.parametrize("name", ["roads", "_private", "a1", "gis_data", "x" * 63])
def test_accepts_plain_lowercase_identifiers(name: str) -> None:
    assert validate_identifier(name) == name


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


def test_rejects_non_string_input() -> None:
    with pytest.raises(InvalidRequestError):
        validate_identifier(None)  # type: ignore[arg-type]


def test_quote_wraps_in_double_quotes() -> None:
    assert quote("roads") == '"roads"'


def test_qualified_builds_schema_qualified_name() -> None:
    assert qualified("gis_data", "roads") == '"gis_data"."roads"'


def test_quote_list_joins_validated_names() -> None:
    assert quote_list(["fid", "name"]) == '"fid", "name"'


def test_quote_list_rejects_a_poisoned_entry() -> None:
    with pytest.raises(InvalidRequestError):
        quote_list(["fid", 'name" , (SELECT 1) AS "x'])


# `quote_catalog_name`/`quote_list_catalog` are the second, narrower quoting
# path for names already confirmed to exist in the catalog (see
# app/db/identifiers.py's module docstring). Unlike `validate_identifier`,
# they accept any character Postgres itself would accept in a quoted
# identifier -- the doubling escape below is the only thing standing between
# such a name and a second-order SQL injection, so it is pinned explicitly.


def test_quote_catalog_name_accepts_a_mixed_case_name_and_round_trips() -> None:
    assert quote_catalog_name("Name") == '"Name"'
    assert quote_catalog_name("population_2020") == '"population_2020"'


def test_quote_catalog_name_doubles_an_embedded_double_quote() -> None:
    assert quote_catalog_name('a" , (SELECT 1) AS "x') == '"a"" , (SELECT 1) AS ""x"'


def test_quote_catalog_name_rejects_an_empty_string() -> None:
    with pytest.raises(InvalidRequestError):
        quote_catalog_name("")


def test_quote_catalog_name_rejects_non_string_input() -> None:
    with pytest.raises(InvalidRequestError):
        quote_catalog_name(None)  # type: ignore[arg-type]


def test_quote_list_catalog_joins_mixed_case_names() -> None:
    assert quote_list_catalog(["fid", "Name"]) == '"fid", "Name"'


def test_quote_list_catalog_rejects_an_empty_entry() -> None:
    with pytest.raises(InvalidRequestError):
        quote_list_catalog(["fid", ""])
