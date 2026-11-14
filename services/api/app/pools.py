"""Bounded independent pools for identity authority and scoped financial work."""
from contextlib import contextmanager

from psycopg_pool import ConnectionPool


class Pools:
    def __init__(self, settings):
        self.auth = self._pool(settings.auth_database_url.get_secret_value(), "moneylens_auth", settings.pool_max_size)
        self.finance = self._pool(settings.database_url.get_secret_value(), "moneylens_runtime", settings.pool_max_size)

    @staticmethod
    def _pool(url, group, size):
        def configure(connection):
            row = connection.execute("""SELECT rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolinherit,
                pg_has_role(session_user,%s,'MEMBER'),pg_has_role(session_user,%s,'MEMBER')
                ,(SELECT array_agg(parent.rolname::text ORDER BY parent.rolname)
                    FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid
                    JOIN pg_roles child ON child.oid=m.member WHERE child.rolname=session_user)
                FROM pg_roles WHERE rolname=session_user""",
                (group, "moneylens_runtime" if group == "moneylens_auth" else "moneylens_auth")).fetchone()
            if row != (False,True,False,[group]):
                raise RuntimeError("Use a restricted NOINHERIT login granted only its designated database group")

        def reset(connection):
            connection.execute("RESET ROLE")
            connection.execute("RESET ALL")
            connection.execute("SET statement_timeout='5s'")
            connection.execute("SET lock_timeout='1s'")
            connection.execute("SET idle_in_transaction_session_timeout='10s'")

        return ConnectionPool(url, min_size=0, max_size=size, max_waiting=100, timeout=5,
            max_lifetime=1800, open=True, configure=configure, reset=reset,
            kwargs={"autocommit":True,"connect_timeout":5,
                    "options":"-c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000"})

    @contextmanager
    def identity(self):
        with self.auth.connection() as connection:
            with connection.transaction():
                connection.execute("SET LOCAL ROLE moneylens_auth")
                yield connection

    def close(self):
        self.auth.close()
        self.finance.close()
