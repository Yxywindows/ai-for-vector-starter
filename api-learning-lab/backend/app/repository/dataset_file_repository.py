"""Repository layer for the `dataset_file` table — raw SQL only."""
from app.db import get_cursor


def find_by_dataset_id(dataset_id: int) -> list[dict]:
    with get_cursor() as cur:
        cur.execute(
            "SELECT * FROM dataset_file WHERE dataset_id = %s ORDER BY created_time DESC",
            (dataset_id,),
        )
        return cur.fetchall()


def create(dataset_id: int, file_name: str, file_path: str, file_type: str, file_size: int) -> dict:
    with get_cursor(commit=True) as cur:
        cur.execute(
            """
            INSERT INTO dataset_file (dataset_id, file_name, file_path, file_type, file_size, created_time)
            VALUES (%s, %s, %s, %s, %s, now())
            RETURNING *
            """,
            (dataset_id, file_name, file_path, file_type, file_size),
        )
        return cur.fetchone()
