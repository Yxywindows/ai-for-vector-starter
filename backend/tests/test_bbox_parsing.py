import pytest

from app.core.errors import InvalidRequestError
from app.schemas.feature import BBox


def test_parses_a_well_formed_bbox() -> None:
    bbox = BBox.parse("100.0,30.0,101.0,31.0")
    assert (bbox.minx, bbox.miny, bbox.maxx, bbox.maxy) == (100.0, 30.0, 101.0, 31.0)


def test_tolerates_whitespace() -> None:
    assert BBox.parse(" 100 , 30 , 101 , 31 ").maxy == 31.0


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "1,2,3",
        "1,2,3,4,5",
        "a,b,c,d",
        "101,30,100,31",  # minx > maxx
        "100,31,101,30",  # miny > maxy
        "-181,0,10,10",  # outside the 4326 domain
        "0,-91,10,10",
        "0,0,181,10",
        "0,0,10,91",
    ],
)
def test_rejects_malformed_or_impossible_boxes(raw: str) -> None:
    with pytest.raises(InvalidRequestError):
        BBox.parse(raw)


def test_as_params_names_match_the_sql_bindings() -> None:
    assert BBox.parse("1,2,3,4").as_params == {"minx": 1.0, "miny": 2.0, "maxx": 3.0, "maxy": 4.0}
