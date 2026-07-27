import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.errors import InvalidRequestError
from app.models.layer import Layer
from app.services.tile_service import tile_etag, validate_tile_coords


def _layer(*, layer_id: uuid.UUID, updated_at: datetime) -> Layer:
    """A Layer built in memory, never persisted -- `tile_etag` only reads
    `.id` and `.updated_at`, so no database is needed to test it."""
    layer = Layer()
    layer.id = layer_id
    layer.updated_at = updated_at
    return layer


@pytest.mark.parametrize(("z", "x", "y"), [(0, 0, 0), (1, 1, 1), (10, 1023, 0), (24, 0, 0)])
def test_accepts_coordinates_inside_the_pyramid(z: int, x: int, y: int) -> None:
    validate_tile_coords(z, x, y)  # must not raise


@pytest.mark.parametrize(
    ("z", "x", "y"),
    [
        (-1, 0, 0),
        (25, 0, 0),
        (0, 1, 0),  # z0 has exactly one tile
        (0, 0, 1),
        (1, 2, 0),
        (1, 0, 2),
        (10, -1, 0),
        (10, 0, -1),
    ],
)
def test_rejects_coordinates_outside_the_pyramid(z: int, x: int, y: int) -> None:
    with pytest.raises(InvalidRequestError):
        validate_tile_coords(z, x, y)


def test_tile_etag_changes_when_the_layer_is_updated() -> None:
    """This is the property `catalog_service`-adjacent callers rely on: renaming or
    restyling a layer must invalidate every cached tile. An API-level test (PATCH the
    layer, refetch the tile, compare ETags) cannot prove this in this suite: every
    request in a test shares one outer Postgres transaction (see `conftest.py`), and
    `updated_at`'s `onupdate=func.now()` resolves to that transaction's *start* time
    for every statement in it -- confirmed directly against the live database, where
    two writes inside one transaction get an identical `now()` even a second apart,
    while two writes in separate transactions (how production's per-request session
    actually works) do not. So this test exercises the part `tile_service` owns
    directly: that `tile_etag` is sensitive to `updated_at` at all.
    """
    layer_id = uuid.uuid4()
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    t1 = t0 + timedelta(seconds=1)
    before = tile_etag(_layer(layer_id=layer_id, updated_at=t0), 0, 0, 0)
    after = tile_etag(_layer(layer_id=layer_id, updated_at=t1), 0, 0, 0)
    assert before != after


def test_tile_etag_changes_per_coordinate_for_a_fixed_layer() -> None:
    layer = _layer(layer_id=uuid.uuid4(), updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    assert tile_etag(layer, 0, 0, 0) != tile_etag(layer, 1, 0, 0)


def test_tile_etag_is_a_weak_etag() -> None:
    layer = _layer(layer_id=uuid.uuid4(), updated_at=datetime(2026, 1, 1, tzinfo=UTC))
    assert tile_etag(layer, 0, 0, 0).startswith('W/"')
