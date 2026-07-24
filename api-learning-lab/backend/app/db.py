"""
Database connection helper.

Deliberately thin: a single connection pool plus a context manager that
hands the repository layer a real cursor. No ORM, no query builder — the
repository layer writes plain SQL so the query stays visible end to end.
"""
import os
from contextlib import contextmanager

from dotenv import load_dotenv
from psycopg2 import pool
from psycopg2.extras import RealDictCursor

load_dotenv()

_pool = pool.SimpleConnectionPool(
    minconn=1,
    maxconn=10,
    host=os.getenv("DB_HOST", "localhost"),
    port=os.getenv("DB_PORT", "5400"),
    dbname=os.getenv("DB_NAME", "api_learning"),
    user=os.getenv("DB_USER", "learning_user"),
    password=os.getenv("DB_PASSWORD", "learning_pass"),
)


@contextmanager
def get_cursor(commit: bool = False):
    """Yield a RealDictCursor (rows come back as dicts) from the pool."""
    conn = _pool.getconn()
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur
        if commit:
            conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        _pool.putconn(conn)
