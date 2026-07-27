import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.ext.asyncio import async_engine_from_config

import app.models  # noqa: F401  -- import for autogenerate
from app.core.config import get_settings
from app.db.base import Base

config = context.config
settings = get_settings()
config.set_main_option("sqlalchemy.url", settings.database_url)

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

target_metadata = Base.metadata
VERSION_SCHEMA = settings.metadata_schema


def include_object(obj, name, type_, reflected, compare_to):
    """Only manage the metadata schema's tables.

    DO NOT widen this to also admit `settings.import_schema` ("gis_data").
    That schema holds tables the file-import pipeline creates at runtime
    (Task 6+) with column/type shapes only known at import time -- they
    have no SQLAlchemy model and never will. `Base.metadata` is permanently
    empty for that schema, so if autogenerate were allowed to reflect
    tables there, it would compare each one against "nothing declared" and
    emit a destructive `op.drop_table(...)` the moment the first import
    table exists. Global Constraints forbid Alembic from managing that
    schema's DDL at all; `gis_data` is created once, via a bare
    `op.execute` in 0001_initial_schema.py, and is otherwise invisible to
    Alembic on purpose.
    """
    if type_ == "table" and obj.schema != settings.metadata_schema:  # noqa: SIM103
        return False
    return True


def do_run_migrations(connection):
    # One-time bootstrap, safe to run on every invocation: `version_table_schema`
    # below requires this schema to exist before Alembic can create its own
    # alembic_version bookkeeping table, which happens before any migration's
    # upgrade() runs -- so migration 0001's own `CREATE SCHEMA IF NOT EXISTS`
    # is too late for a genuinely fresh database. Doing it here, from settings,
    # keeps the requirement in code instead of a manual operational step.
    connection.exec_driver_sql(f'CREATE SCHEMA IF NOT EXISTS "{settings.metadata_schema}"')
    # Commit this as its own unit of work. `exec_driver_sql` auto-begins a
    # transaction on `connection`; if it's left open, Alembic's own
    # `context.begin_transaction()` below treats a transaction that's already
    # in progress as one it doesn't own, and skips committing it -- silently
    # rolling back both the schema creation *and* the migration itself when
    # the connection closes. Verified by reproducing exactly that against a
    # real container before adding this line.
    connection.commit()

    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        include_schemas=True,
        include_object=include_object,
        version_table_schema=VERSION_SCHEMA,
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations():
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
        # Force a known default schema for this connection instead of relying on
        # server-side role configuration. Postgres's default search_path is
        # `"$user", public, ...`; this project's db user happens to be named the
        # same as its metadata schema ("gis"), so without this, "gis" silently
        # becomes this connection's default schema, and reflection then reports
        # objects in it as schema-less -- producing false-positive autogenerate
        # drift on every foreign key into that schema. Scoped to this migration
        # connection only, so it can't affect the raw SQL the import pipeline
        # (Tasks 5, 6, 9) runs over its own, separately-created connections.
        connect_args={"server_settings": {"search_path": "public"}},
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online():
    asyncio.run(run_async_migrations())


run_migrations_online()
