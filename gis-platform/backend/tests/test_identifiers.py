import pytest

from app.core.errors import InvalidRequestError
from app.db.identifiers import qualified, quote, quote_list, validate_identifier


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
