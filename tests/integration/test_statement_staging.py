from datetime import date, datetime, timedelta, timezone
from uuid import uuid4
import psycopg
import pytest
from app.database import TrustedScope, tenant_transaction


def test_statement_staging_is_owner_scoped_and_receipts_are_idempotent(database,owners):
    first, second = owners[:2]
    preview_id=uuid4(); receipt_id=uuid4(); now=datetime.now(timezone.utc)
    scope1=TrustedScope(first[0],first[1]); scope2=TrustedScope(second[0],second[1])
    with psycopg.connect(database['runtime'],autocommit=True) as conn:
        with tenant_transaction(conn,scope1):
            conn.execute('''INSERT INTO moneylens.statement_previews
                (tenant_id,owner_user_id,id,session_id,file_sha256,account_id,account_label,period_from,period_to_exclusive,encrypted_rows,created_at,expires_at)
                VALUES (%s,%s,%s,%s,%s,%s,'Synthetic account',%s,%s,%s,%s,%s)''',
                (*first[:2],preview_id,uuid4(),'a'*64,first[2],date(2026,1,1),date(2026,2,1),b'encrypted-test-only',now,now+timedelta(minutes=10)))
            conn.execute('''INSERT INTO moneylens.statement_import_receipts
                (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,1)''',(*first[:2],receipt_id,first[2],'a'*64,date(2026,1,1),date(2026,2,1)))
        with tenant_transaction(conn,scope2):
            assert conn.execute('SELECT id FROM moneylens.statement_previews WHERE id=%s',(preview_id,)).fetchall()==[]
            assert conn.execute('SELECT id FROM moneylens.statement_import_receipts WHERE id=%s',(receipt_id,)).fetchall()==[]
            assert conn.execute('DELETE FROM moneylens.statement_previews WHERE id=%s RETURNING id',(preview_id,)).fetchall()==[]
        with pytest.raises(psycopg.errors.UniqueViolation):
            with tenant_transaction(conn,scope1):
                conn.execute('''INSERT INTO moneylens.statement_import_receipts
                    (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,1)''',(*first[:2],uuid4(),first[2],'a'*64,date(2026,1,1),date(2026,2,1)))
        with tenant_transaction(conn,scope1):
            assert conn.execute('SELECT id FROM moneylens.statement_previews WHERE id=%s',(preview_id,)).fetchone()==(preview_id,)


def test_statement_preview_rejects_unbounded_expiry_and_empty_ciphertext(database,owners):
    owner=owners[0]; scope=TrustedScope(owner[0],owner[1]); now=datetime.now(timezone.utc)
    with psycopg.connect(database['runtime'],autocommit=True) as conn:
        for ciphertext,expiry in ((b'',now+timedelta(minutes=10)),(b'opaque',now+timedelta(minutes=31))):
            with pytest.raises(psycopg.errors.CheckViolation):
                with tenant_transaction(conn,scope):
                    conn.execute("""INSERT INTO moneylens.statement_previews
                        (tenant_id,owner_user_id,id,session_id,file_sha256,account_label,period_from,period_to_exclusive,encrypted_rows,created_at,expires_at)
                        VALUES (%s,%s,%s,%s,%s,'Synthetic',%s,%s,%s,%s,%s)""",
                        (*owner[:2],uuid4(),uuid4(),'b'*64,date(2026,1,1),date(2026,2,1),ciphertext,now,expiry))
