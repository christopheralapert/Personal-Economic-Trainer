"""Migrate and seed local synthetic identity; credentials stay in gitignored .env."""
import os
from pathlib import Path
import secrets
import sys

from alembic import command
from alembic.config import Config
from dotenv import dotenv_values, set_key
import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT / "backend/api"))

from app.seed import seed_synthetic


def main():
    url = os.environ.get("MONEYLENS_MIGRATION_DATABASE_URL","postgresql://moneylens:moneylens_local@127.0.0.1:5432/moneylens")
    params = conninfo_to_dict(url)
    if params.get("host") not in ("127.0.0.1","localhost") or params.get("dbname") != "moneylens":
        raise RuntimeError("This setup command is restricted to the local moneylens database")
    engine = create_engine("postgresql+psycopg://",creator=lambda:psycopg.connect(url),poolclass=NullPool)
    with engine.begin() as connection:
        config = Config(str(ROOT / "alembic.ini"))
        config.attributes["connection"] = connection
        command.upgrade(config,"head")
    engine.dispose()
    target = ROOT / ".env"
    values = dotenv_values(target) if target.exists() else {}
    updates = {}
    with psycopg.connect(url) as connection:
        for name,group,variable in (("moneylens_api_local","moneylens_runtime","MONEYLENS_DATABASE_URL"),
                                    ("moneylens_auth_local","moneylens_auth","MONEYLENS_AUTH_DATABASE_URL")):
            existing = connection.execute("SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit FROM pg_roles WHERE rolname=%s",(name,)).fetchone()
            if existing:
                if existing != (False,) or not values.get(variable) or conninfo_to_dict(values[variable]).get("user") != name:
                    raise RuntimeError("Existing local roles need matching restricted credentials in .env; no password was changed")
            else:
                if values.get(variable):
                    raise RuntimeError("Existing database configuration is preserved; use explicit administrative provisioning")
                password = secrets.token_urlsafe(32)
                connection.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD {}").format(sql.Identifier(name),sql.Literal(password)))
                connection.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(group),sql.Identifier(name)))
                updates[variable] = make_conninfo(url,user=name,password=password)
        seed_synthetic(connection)
    updates.update({"MONEYLENS_AUTH_ENABLED":"true","MONEYLENS_ENVIRONMENT":"development",
        "MONEYLENS_ALLOW_DEMO":"true","MONEYLENS_APP_ORIGIN":"http://127.0.0.1:3000"})
    updates["MONEYLENS_SESSION_SECRET"] = values.get("MONEYLENS_SESSION_SECRET") or secrets.token_urlsafe(48)
    for key,value in updates.items():
        set_key(target,key,value,quote_mode="always")
    print("Local synthetic identity is ready. Restricted credentials were written only to gitignored .env.")


if __name__ == "__main__":
    main()
