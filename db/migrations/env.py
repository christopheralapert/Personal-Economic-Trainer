"""Migration credentials are separate from runtime credentials and never printed."""
import os
from pathlib import Path

from alembic import context
from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

load_dotenv(Path(__file__).resolve().parents[2] / ".env", override=False)


def database_url() -> str:
    url = os.environ.get("MONEYLENS_MIGRATION_DATABASE_URL")
    if not url:
        raise RuntimeError("Set MONEYLENS_MIGRATION_DATABASE_URL explicitly; runtime credentials are not used for migrations")
    return url.replace("postgresql://", "postgresql+psycopg://", 1)


if context.is_offline_mode():
    context.configure(url=database_url(), literal_binds=True, dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()
else:
    supplied = context.config.attributes.get("connection")
    if supplied is not None:
        context.configure(connection=supplied)
        with context.begin_transaction():
            context.run_migrations()
    else:
        with create_engine(database_url(), poolclass=NullPool).connect() as connection:
            context.configure(connection=connection)
            with context.begin_transaction():
                context.run_migrations()
