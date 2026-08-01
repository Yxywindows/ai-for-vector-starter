"""Seed synthetic benchmark layers and measure the hot read paths.

Usage (from backend/, venv active, backend running for `measure`):

    python scripts/bench.py seed            # create 10K / 100K / 1M point layers
    python scripts/bench.py measure         # p50/p95 latency for tiles + features
    python scripts/bench.py clean           # drop the Benchmarks project + tables

Seeding writes plain SQL through the app's own database URL: a
`Benchmarks` project (created if missing) gains one layer per size, each
backed by a `gis_data.bench_points_<n>` table with a GIST index, a PK and
fresh statistics — exactly the shape the import path produces. Everything
is additive and `clean` removes all of it; user data is never touched.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import uuid

from sqlalchemy import create_engine, text

sys.path.insert(0, ".")

from app.core.config import get_settings

SIZES = [10_000, 100_000, 1_000_000]
PROJECT_NAME = "Benchmarks"


def sync_url() -> str:
    # Same driver swap the app's own sync engine performs (db/sync_engine.py).
    return get_settings().database_url.replace("+asyncpg", "+psycopg")


def seed() -> None:
    engine = create_engine(sync_url())
    with engine.begin() as conn:
        project_id = conn.execute(
            text("SELECT id FROM gis.project WHERE name = :name"), {"name": PROJECT_NAME}
        ).scalar_one_or_none()
        if project_id is None:
            project_id = uuid.uuid4()
            conn.execute(
                text(
                    "INSERT INTO gis.project (id, name, view) "
                    'VALUES (:id, :name, \'{"center": [105, 35], "zoom": 3}\')'
                ),
                {"id": project_id, "name": PROJECT_NAME},
            )

        for size in SIZES:
            table = f"bench_points_{size}"
            started = time.perf_counter()
            conn.execute(text(f'DROP TABLE IF EXISTS gis_data."{table}"'))
            conn.execute(
                text(
                    f"""
                    CREATE TABLE gis_data."{table}" AS
                    SELECT gs AS fid,
                           'point-' || gs AS name,
                           (random() * 1000)::int AS score,
                           ST_SetSRID(ST_MakePoint(
                               73 + random() * 62,   -- lon spread across China
                               18 + random() * 35    -- lat
                           ), 4326)::geometry(Point, 4326) AS geometry
                    FROM generate_series(1, {size}) AS gs
                    """
                )
            )
            conn.execute(text(f'ALTER TABLE gis_data."{table}" ADD PRIMARY KEY (fid)'))
            conn.execute(
                text(f'CREATE INDEX "ix_{table}_geom" ON gis_data."{table}" USING GIST (geometry)')
            )
            conn.execute(text(f'ANALYZE gis_data."{table}"'))

            layer_name = f"Bench {size:,}"
            conn.execute(
                text("DELETE FROM gis.layer WHERE project_id = :pid AND name = :name"),
                {"pid": project_id, "name": layer_name},
            )
            source = {
                "type": "postgis",
                "schema_name": "gis_data",
                "table_name": table,
                "geometry_column": "geometry",
                "id_column": "fid",
                "srid": 4326,
            }
            conn.execute(
                text(
                    "INSERT INTO gis.layer (id, project_id, name, kind, source, style, visible,"
                    " opacity, z_index, extent, feature_count, srid, geometry_type) VALUES "
                    "(:id, :pid, :name, 'vector', :source, '{}', true, 1.0, :z,"
                    " '[73, 18, 135, 53]', :count, 4326, 'POINT')"
                ),
                {
                    "id": uuid.uuid4(),
                    "pid": project_id,
                    "name": layer_name,
                    "source": json.dumps(source),
                    "z": SIZES.index(size),
                    "count": size,
                },
            )
            print(f"seeded {layer_name}: {time.perf_counter() - started:.1f}s")
    print("done — open the Benchmarks project via the API or reassign layers as needed")


def _percentiles(samples: list[float]) -> str:
    ordered = sorted(samples)
    p50 = ordered[len(ordered) // 2]
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    return f"p50 {p50 * 1000:6.1f} ms   p95 {p95 * 1000:6.1f} ms"


def measure(base: str) -> None:
    import httpx

    with httpx.Client(base_url=base, timeout=60) as client:
        projects = client.get("/api/v1/projects").json()
        project = next(p for p in projects if p["name"] == PROJECT_NAME)
        layers = client.get(f"/api/v1/projects/{project['id']}").json()["layers"]

        for layer in sorted(layers, key=lambda item: item["featureCount"] or 0):
            layer_id, count = layer["id"], layer["featureCount"]

            # Vector tiles over a mid-zoom viewport around the seeded extent.
            tiles = [(5, 25 + dx, 12 + dy) for dx in range(3) for dy in range(2)]
            cold: list[float] = []
            for z, x, y in tiles:
                start = time.perf_counter()
                client.get(f"/api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.mvt")
                cold.append(time.perf_counter() - start)
            warm: list[float] = []
            for _ in range(5):
                for z, x, y in tiles:
                    start = time.perf_counter()
                    client.get(f"/api/v1/layers/{layer_id}/tiles/{z}/{x}/{y}.mvt")
                    warm.append(time.perf_counter() - start)

            # A viewport features request, as the medium tier issues it.
            feature_times: list[float] = []
            for _ in range(10):
                start = time.perf_counter()
                client.get(
                    f"/api/v1/layers/{layer_id}/features",
                    params={"bbox": "95,25,115,40", "simplify": 0.01},
                )
                feature_times.append(time.perf_counter() - start)

            # Attribute page (estimate fast-path above the threshold).
            attr_times: list[float] = []
            for _ in range(10):
                start = time.perf_counter()
                body = client.get(f"/api/v1/layers/{layer_id}/attributes").json()
                attr_times.append(time.perf_counter() - start)

            print(f"\n{layer['name']}  ({count:,} features)")
            print(f"  tiles cold : {_percentiles(cold)}")
            print(f"  tiles warm : {_percentiles(warm)}")
            print(f"  features   : {_percentiles(feature_times)}")
            estimated = " (estimated)" if body.get("totalEstimated") else " (exact)"
            print(f"  attributes : {_percentiles(attr_times)}   total {body['total']:,}{estimated}")


def clean() -> None:
    engine = create_engine(sync_url())
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM gis.project WHERE name = :name"), {"name": PROJECT_NAME})
        for size in SIZES:
            conn.execute(text(f'DROP TABLE IF EXISTS gis_data."bench_points_{size}"'))
    print("benchmark project and tables removed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["seed", "measure", "clean"])
    parser.add_argument("--base", default="http://localhost:1316")
    args = parser.parse_args()
    if args.command == "seed":
        seed()
    elif args.command == "measure":
        measure(args.base)
    else:
        clean()
