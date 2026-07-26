import pytest
from pydantic import ValidationError

from app.schemas.layer import LayerCreate, LayerRead
from app.schemas.source import MvtSource, PostgisSource, parse_source
from app.schemas.style import (
    CategorizedRenderer,
    GraduatedRenderer,
    RasterStyle,
    VectorStyle,
    default_style_for,
    parse_style,
)


def test_source_union_dispatches_on_type() -> None:
    source = parse_source(
        {
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        }
    )
    assert isinstance(source, PostgisSource)
    assert source.table_name == "roads"


def test_source_union_rejects_unknown_type() -> None:
    with pytest.raises(ValidationError):
        parse_source({"type": "shapefile", "path": "/tmp/x.shp"})


def test_source_round_trips_to_camel_case() -> None:
    source = MvtSource(type="mvt", url="https://tiles/{z}/{x}/{y}.pbf", source_layer="water")
    assert source.model_dump(by_alias=True) == {
        "type": "mvt",
        "url": "https://tiles/{z}/{x}/{y}.pbf",
        "sourceLayer": "water",
    }


def test_vector_style_defaults_to_single_renderer() -> None:
    style = default_style_for("vector")
    assert isinstance(style, VectorStyle)
    assert style.renderer.type == "single"
    assert style.fill.color.startswith("#")
    assert 0.0 <= style.fill.opacity <= 1.0


def test_raster_style_defaults() -> None:
    style = default_style_for("raster")
    assert isinstance(style, RasterStyle)
    assert style.bands == [1]
    assert style.opacity == 1.0


def test_categorized_renderer_requires_a_field_and_categories() -> None:
    with pytest.raises(ValidationError):
        CategorizedRenderer(type="categorized", field="", categories=[])


def test_graduated_renderer_rejects_inverted_class_bounds() -> None:
    with pytest.raises(ValidationError):
        GraduatedRenderer(
            type="graduated",
            field="pop",
            classes=[{"min": 100, "max": 10, "color": "#ff0000"}],
        )


def test_colour_must_be_a_hex_triplet() -> None:
    with pytest.raises(ValidationError):
        VectorStyle(kind="vector", fill={"color": "rebeccapurple"})


def test_parse_style_returns_none_for_empty_jsonb() -> None:
    assert parse_style({}) is None


def test_layer_create_defaults_style_when_omitted() -> None:
    payload = LayerCreate(
        name="Roads",
        kind="vector",
        source={
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        },
    )
    assert payload.style is not None
    assert payload.style.kind == "vector"


def test_layer_read_serialises_camel_case_from_orm_attributes() -> None:
    class FakeLayer:
        id = "8b1b0e0e-0000-4000-8000-000000000000"
        project_id = "8b1b0e0e-0000-4000-8000-000000000001"
        name = "Roads"
        kind = "vector"
        source = {  # noqa: RUF012 -- plain test double, not a dataclass
            "type": "postgis",
            "schemaName": "gis_data",
            "tableName": "roads",
            "geometryColumn": "geometry",
            "idColumn": "fid",
            "srid": 4326,
        }
        style = {"kind": "vector"}  # noqa: RUF012 -- plain test double, not a dataclass
        visible = True
        opacity = 1.0
        z_index = 3
        extent = [-180.0, -90.0, 180.0, 90.0]  # noqa: RUF012 -- plain test double, not a dataclass
        feature_count = 42
        srid = 4326
        geometry_type = "MULTILINESTRING"

    dumped = LayerRead.model_validate(FakeLayer()).model_dump(by_alias=True)
    assert dumped["zIndex"] == 3
    assert dumped["featureCount"] == 42
    assert dumped["geometryType"] == "MULTILINESTRING"
    assert "z_index" not in dumped
