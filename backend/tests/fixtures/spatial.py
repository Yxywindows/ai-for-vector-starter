"""A real PostGIS table for the tests that exercise dynamic SQL."""

from __future__ import annotations

from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.source import PostgisSource

CREATE = """
CREATE TABLE gis_data.test_cities (
    fid        serial PRIMARY KEY,
    name       text NOT NULL,
    population integer,
    geometry   geometry(Point, 4326)
)
"""

SEED = """
INSERT INTO gis_data.test_cities (name, population, geometry) VALUES
    ('Beijing',  21540000, ST_SetSRID(ST_MakePoint(116.4074, 39.9042), 4326)),
    ('Shanghai', 24870000, ST_SetSRID(ST_MakePoint(121.4737, 31.2304), 4326)),
    ('Lhasa',      560000, ST_SetSRID(ST_MakePoint( 91.1409, 29.6450), 4326))
"""


@pytest_asyncio.fixture
async def seeded_spatial_table(db_session: AsyncSession) -> AsyncIterator[PostgisSource]:
    await db_session.execute(text("DROP TABLE IF EXISTS gis_data.test_cities"))
    await db_session.execute(text(CREATE))
    await db_session.execute(text(SEED))
    await db_session.execute(
        text("CREATE INDEX ix_test_cities_geometry ON gis_data.test_cities USING GIST (geometry)")
    )
    await db_session.flush()
    yield PostgisSource(
        schema_name="gis_data",
        table_name="test_cities",
        geometry_column="geometry",
        id_column="fid",
        srid=4326,
    )
    # The outer transaction rollback in `db_connection` removes the table.
