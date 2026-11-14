"""Opt-in live services. Only uniquely created test resources are removed."""
import os
from contextlib import contextmanager
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo
from sqlalchemy import create_engine
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="session")
def database():
    url = os.environ.get("MONEYLENS_TEST_DATABASE_URL")
    if not url:
        if os.environ.get("MONEYLENS_STATEMENT_BROWSER_TEST") == "true":
            pytest.fail("MONEYLENS_STATEMENT_BROWSER_TEST=true requires MONEYLENS_TEST_DATABASE_URL; the requested browser verification must not be skipped")
        pytest.skip("Set MONEYLENS_TEST_DATABASE_URL to an isolated local/CI administrator database")
    name = "moneylens_test_" + uuid4().hex
    login = "ml_test_" + uuid4().hex
    auth_login = "ml_auth_test_" + uuid4().hex
    password = uuid4().hex
    admin = psycopg.connect(url, autocommit=True)
    created_role = False
    created_auth = False
    admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
    params = conninfo_to_dict(url)
    params["dbname"] = name
    test_url = make_conninfo(**params)
    engine = create_engine("postgresql+psycopg://", creator=lambda: psycopg.connect(test_url), poolclass=NullPool)
    config = Config(str(ROOT / "backend/db/alembic.ini"))
    try:
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
        admin.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD {}").format(sql.Identifier(login), sql.Literal(password)))
        created_role = True
        admin.execute(sql.SQL("GRANT moneylens_runtime TO {}").format(sql.Identifier(login)))
        admin.execute(sql.SQL("CREATE ROLE {} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD {}").format(sql.Identifier(auth_login),sql.Literal(password)))
        created_auth = True
        admin.execute(sql.SQL("GRANT moneylens_auth TO {}").format(sql.Identifier(auth_login)))
        runtime_url = make_conninfo(test_url, user=login, password=password)
        auth_url = make_conninfo(test_url,user=auth_login,password=password)
        yield {"admin": test_url, "runtime": runtime_url,"auth":auth_url, "engine": engine, "config": config}
    finally:
        config.attributes.pop("connection", None)
        engine.dispose()
        # These exact names were generated and created by this fixture, never user databases.
        admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
        if created_role:
            admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(login)))
        if created_auth:
            admin.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(auth_login)))
        admin.close()


@pytest.fixture
def migration_database(database):
    """Build historical schemas forward in their own database, never downgrade shared data."""
    @contextmanager
    def create(revision):
        name="moneylens_migration_"+uuid4().hex
        params=conninfo_to_dict(database["admin"])
        params["dbname"]=name
        url=make_conninfo(**params)
        admin=psycopg.connect(database["admin"],autocommit=True)
        admin.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(name)))
        engine=create_engine("postgresql+psycopg://",creator=lambda:psycopg.connect(url),poolclass=NullPool)
        config=Config(str(ROOT/"backend/db/alembic.ini"))
        try:
            with engine.begin() as connection:
                config.attributes["connection"]=connection
                command.upgrade(config,revision)
            config.attributes.pop("connection",None)
            yield {"admin":url,"runtime":make_conninfo(database["runtime"],dbname=name),
                "auth":make_conninfo(database["auth"],dbname=name),"engine":engine,"config":config}
        finally:
            config.attributes.pop("connection",None)
            engine.dispose()
            # Only this exact generated database was created by this context.
            admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
            admin.close()
    return create


@pytest.fixture
def owners(database):
    tenant, other_tenant = uuid4(), uuid4()
    rows = [(tenant, uuid4(), uuid4()), (tenant, uuid4(), uuid4()), (other_tenant, uuid4(), uuid4())]
    with psycopg.connect(database["admin"], autocommit=True) as connection:
        for tid in (tenant, other_tenant):
            connection.execute("INSERT INTO moneylens.tenants (id,name) VALUES (%s,'Synthetic integration tenant')", (tid,))
        for tid, uid, aid in rows:
            connection.execute("INSERT INTO moneylens.users (tenant_id,id,subject_issuer,subject_id) VALUES (%s,%s,'integration',%s)", (tid, uid, str(uid)))
            connection.execute("INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Synthetic account','EUR','current')", (tid, uid, aid))
            connection.execute("INSERT INTO moneylens.user_state (tenant_id,owner_user_id,id) VALUES (%s,%s,%s)",(tid,uid,uuid4()))
    try:
        yield rows
    finally:
        with psycopg.connect(database["admin"],autocommit=True) as connection:
            connection.execute("DELETE FROM moneylens.tenants WHERE id=ANY(%s)",([tenant,other_tenant],))
