from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.script import ScriptDirectory

from app.database import TrustedScope, tenant_transaction


def scope(owner):
    return TrustedScope(owner[0], owner[1])


def insert_transaction(connection, owner, source="source-1", account_id=None, amount=-100, currency="EUR"):
    connection.execute("""INSERT INTO moneylens.transactions
        (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow)
        VALUES (%s,%s,%s,%s,%s,%s,%s,'2026-11-04','booked','Synthetic shop','groceries','mandatory_irregular','expense')""",
        (owner[0], owner[1], uuid4(), account_id or owner[2], source, amount, currency))


def test_real_non_owner_login_sees_only_own_rows(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        for owner in owners:
            with tenant_transaction(connection, scope(owner)):
                assert connection.execute("SELECT id FROM moneylens.accounts").fetchall() == [(owner[2],)]
                assert connection.execute("SELECT id FROM moneylens.users").fetchall() == [(owner[1],)]
                assert connection.execute("SELECT id FROM moneylens.tenants").fetchall() == [(owner[0],)]
        with connection.transaction():
            connection.execute("SET LOCAL ROLE moneylens_runtime")
            assert connection.execute("SELECT count(*) FROM moneylens.accounts").fetchone()[0] == 0


def test_cross_owner_insert_rejected_and_connection_recovers(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        for foreign_owner in owners[1:]:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with tenant_transaction(connection, scope(owners[0])):
                    insert_transaction(connection, foreign_owner)
        with tenant_transaction(connection, scope(owners[0])):
            assert connection.execute("SELECT id FROM moneylens.accounts").fetchall() == [(owners[0][2],)]
        assert connection.execute("SELECT current_user = session_user").fetchone()[0]
        assert connection.execute("SELECT nullif(current_setting('app.user_id',true),'')").fetchone()[0] is None


def test_foreign_rows_cannot_be_updated_or_deleted(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with tenant_transaction(connection, scope(owners[0])):
            for foreign_owner in owners[1:]:
                assert connection.execute("UPDATE moneylens.accounts SET name='tampered' WHERE id=%s", (foreign_owner[2],)).rowcount == 0
                assert connection.execute("DELETE FROM moneylens.accounts WHERE id=%s", (foreign_owner[2],)).rowcount == 0
            assert connection.execute("UPDATE moneylens.accounts SET name='Own edit' WHERE id=%s", (owners[0][2],)).rowcount == 1


def test_partial_and_mismatched_context_fail_closed(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        for tenant_id, user_id in [(str(owners[0][0]), ""), ("", str(owners[0][1])), (str(owners[0][0]), str(owners[2][1]))]:
            with connection.transaction():
                connection.execute("SET LOCAL ROLE moneylens_runtime")
                connection.execute("SELECT set_config('app.tenant_id',%s,true), set_config('app.user_id',%s,true)", (tenant_id,user_id))
                assert connection.execute("SELECT count(*) FROM moneylens.accounts").fetchone()[0] == 0
                assert connection.execute("SELECT count(*) FROM moneylens.tenants").fetchone()[0] == 0


def test_rollback_clears_context_before_reuse(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with pytest.raises(ZeroDivisionError):
            with tenant_transaction(connection, scope(owners[0])):
                raise ZeroDivisionError("synthetic failure")
        assert connection.execute("SELECT current_user = session_user").fetchone()[0]
        assert connection.execute("SELECT nullif(current_setting('app.user_id',true),'')").fetchone()[0] is None
        with tenant_transaction(connection, scope(owners[2])):
            assert connection.execute("SELECT id FROM moneylens.accounts").fetchall() == [(owners[2][2],)]


@pytest.mark.parametrize("foreign_index", [1, 2])
def test_scoped_foreign_keys_reject_foreign_account(database, owners, foreign_index):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            with tenant_transaction(connection, scope(owners[0])):
                insert_transaction(connection, owners[0], account_id=owners[foreign_index][2])


def test_replay_is_unique_but_identical_distinct_purchases_survive(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with tenant_transaction(connection, scope(owners[0])):
            insert_transaction(connection, owners[0], "first")
            insert_transaction(connection, owners[0], "second")
        with pytest.raises(psycopg.errors.UniqueViolation):
            with tenant_transaction(connection, scope(owners[0])):
                insert_transaction(connection, owners[0], "first")
        with tenant_transaction(connection, scope(owners[0])):
            assert connection.execute("SELECT count(*) FROM moneylens.transactions").fetchone()[0] == 2


@pytest.mark.parametrize("amount,currency", [(9007199254740992, "EUR"), (-9007199254740992, "EUR"), (1, "eur"), (1, "EURO")])
def test_money_domains_reject_invalid_values(database, owners, amount, currency):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with pytest.raises(psycopg.errors.CheckViolation):
            with tenant_transaction(connection, scope(owners[0])):
                insert_transaction(connection, owners[0], amount=amount, currency=currency)


def test_runtime_cannot_truncate_alter_or_rewrite_audit(database, owners):
    statements = ["TRUNCATE moneylens.accounts CASCADE", "ALTER TABLE moneylens.accounts DISABLE ROW LEVEL SECURITY",
                  "UPDATE moneylens.audit_events SET action='tampered'", "DELETE FROM moneylens.audit_events"]
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        for statement in statements:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                with tenant_transaction(connection, scope(owners[0])):
                    connection.execute(statement)
        with tenant_transaction(connection, scope(owners[0])):
            connection.execute("INSERT INTO moneylens.audit_events (tenant_id,owner_user_id,id,action,trace_id) VALUES (%s,%s,%s,'synthetic.check',%s)", (owners[0][0],owners[0][1],uuid4(),uuid4()))
            assert connection.execute("SELECT count(*) FROM moneylens.audit_events").fetchone()[0] == 1


def test_every_owned_table_forces_rls_and_has_scoped_references(database):
    with psycopg.connect(database["admin"], autocommit=True) as connection:
        tables = connection.execute("""SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,
            pg_get_userbyid(c.relowner) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='moneylens' AND c.relkind='r' AND c.relname <> 'public_benchmark_releases'""").fetchall()
        # 0029 adds the private, owner-scoped merchant rules table.
        assert len(tables) == 43
        assert {"statement_previews","statement_import_receipts","statement_accounts"}<={row[0] for row in tables}
        assert all(enabled and forced and owner != "moneylens_runtime" for _, enabled, forced, owner in tables)
        refs = connection.execute("""SELECT pg_get_constraintdef(c.oid), target.relname FROM pg_constraint c
            JOIN pg_namespace n ON n.oid=c.connamespace
            JOIN pg_class target ON target.oid=c.confrelid
            WHERE n.nspname='moneylens' AND c.contype='f'""").fetchall()
        assert len(refs) >= 30
        for definition, target in refs:
            if target in ("tenants", "public_benchmark_releases"):
                continue
            assert "FOREIGN KEY (tenant_id, owner_user_id" in definition
        assert connection.execute("SELECT rolsuper OR rolbypassrls OR rolcanlogin FROM pg_roles WHERE rolname='moneylens_runtime'").fetchone() == (False,)


def test_nested_transactions_and_unvalidated_scope_rejected(database, owners):
    with pytest.raises(TypeError):
        TrustedScope(str(owners[0][0]), owners[0][1])
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        with tenant_transaction(connection, scope(owners[0])):
            with pytest.raises(RuntimeError):
                with tenant_transaction(connection, scope(owners[0])):
                    pass


def test_blocked_snapshot_requires_no_amount_and_real_blocker(database, owners):
    with psycopg.connect(database["runtime"], autocommit=True) as connection:
        for result, blockers in [('{"amount_minor":100}', '["missing_balance"]'), ('{"amount_minor":null}', '[]')]:
            with pytest.raises(psycopg.errors.CheckViolation):
                with tenant_transaction(connection, scope(owners[0])):
                    connection.execute("""INSERT INTO moneylens.calculation_snapshots
                        (tenant_id,owner_user_id,id,data_version,calculation_version,as_of,status,result,evidence,blockers)
                        VALUES (%s,%s,%s,1,1,now(),'blocked',%s,'[]',%s)""", (owners[0][0],owners[0][1],uuid4(),result,blockers))


def test_forward_migration_reaches_current_head_and_refuses_unsafe_downgrade(migration_database):
    with migration_database("head") as scratch:
        config=scratch["config"]
        expected=ScriptDirectory.from_config(config).get_current_head()
        with scratch["engine"].connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()==expected
        with pytest.raises(RuntimeError,match="explicit retention and archive plan"):
            with scratch["engine"].begin() as connection:
                config.attributes["connection"]=connection
                command.downgrade(config,"base")
        config.attributes.pop("connection",None)
        with scratch["engine"].connect() as connection:
            assert connection.exec_driver_sql("SELECT version_num FROM alembic_version").scalar()==expected
            assert connection.exec_driver_sql("SELECT to_regclass('moneylens.statement_import_receipts')").scalar()
