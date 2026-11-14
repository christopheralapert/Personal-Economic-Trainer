"""Opt-in, session-bound CSV preview and atomic ledger publication."""
import base64
import hashlib
import hmac
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4, uuid5

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Request
from pydantic import Field, StrictStr
from psycopg.types.json import Jsonb
from typing import Annotated, Literal
from .auth_routes import write_principal
from .database import TrustedScope, tenant_transaction
from .contracts import Contract
from .identity import AuthError, authorized_transaction
from .statement_wise import WiseStatementError
from .statement_normalization import (
    MAX_UPLOAD_BYTES, PUBLIC_FORMATS, StatementNormalizationError, decode_normalized,
    normalize_statement, row_sha256,
)

router=APIRouter()

class WiseUpload(Contract):
    csv: Annotated[StrictStr,Field(min_length=1,max_length=MAX_UPLOAD_BYTES)]
    account_id: UUID | None = None

class StatementUpload(WiseUpload):
    format: Literal['wise_csv', 'canonical_csv']

class WiseConfirm(Contract):
    preview_id: UUID


def cipher(settings,user):
    secret=settings.session_secret.get_secret_value().encode()
    digest=hmac.digest(secret,b'wise-preview.v1:'+user.token.encode(), 'sha256')
    return Fernet(base64.urlsafe_b64encode(digest))


def enabled(request):
    if not request.app.state.settings.statement_imports_enabled:
        raise AuthError('IMPORT_UNAVAILABLE',503)


def clean(connection,owner):
    connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND expires_at<=clock_timestamp()',owner)


def receipt(connection,owner,digest,normalized_digest=None):
    return connection.execute('''SELECT id,account_id,row_count,period_from,period_to_exclusive,source_format
        FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
        AND (file_sha256=%s OR normalized_sha256=%s)''',
        (*owner,digest,normalized_digest)).fetchone()


def published(row):
    return {'state':'published','id':str(row[0]),'account_id':str(row[1]),'count':row[2],
        'start':row[3].isoformat(),'end_exclusive':row[4].isoformat(),'currency':'EUR',
        'source_format':row[5],'account_identity':'unverified','period_basis':'transaction_dates','overlap':'none'}


def target_account(connection,owner,requested,source_format):
    """A selected owned account is a destination, not proof of bank identity."""
    if requested is None:
        previous=connection.execute('''SELECT account_id FROM moneylens.statement_import_receipts
            WHERE tenant_id=%s AND owner_user_id=%s AND source_format IN ('wise_csv','canonical_csv')
            ORDER BY published_at,id LIMIT 1''',owner).fetchone()
        requested=previous[0] if previous else None
    if requested is None:
        return None,'Wise CSV' if source_format=='wise_csv' else 'Canonical CSV'
    account=connection.execute('''SELECT name,currency,native_feed_id,included FROM moneylens.accounts
        WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',(*owner,requested)).fetchone()
    if not account or not account[3]:
        raise AuthError('NOT_FOUND',404)
    if account[1]!='EUR':
        raise AuthError('INVALID_IMPORT_COMMAND',422)
    if account[2] is not None or connection.execute('''SELECT 1 FROM moneylens.account_source_aliases
        WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s LIMIT 1''',(*owner,requested)).fetchone():
        raise AuthError('STATEMENT_OVERLAP',409)
    if connection.execute('''SELECT 1 FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s
        AND account_id=%s AND statement_receipt_id IS NULL LIMIT 1''',(*owner,requested)).fetchone():
        raise AuthError('STATEMENT_OVERLAP',409)
    if connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
        AND account_id=%s AND source_format NOT IN ('wise_csv','canonical_csv') LIMIT 1''',(*owner,requested)).fetchone():
        raise AuthError('STATEMENT_OVERLAP',409)
    return requested,account[0]


def check_overlap(connection,owner,account,low,high):
    if account is not None and connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts
        WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s
        AND period_from<%s AND period_to_exclusive>%s LIMIT 1''',(*owner,account,high,low)).fetchone():
        raise AuthError('STATEMENT_OVERLAP',409)
    # Wise CSV has no verified account identity. A selected destination does not
    # establish equivalence with an AIS account, even when its label matches.
    if connection.execute('''SELECT 1 FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s
        AND provider ILIKE '%%wise%%' AND provider_mode IN ('live','sandbox') LIMIT 1''',owner).fetchone():
        raise AuthError('STATEMENT_OVERLAP',409)


def same_destination(old,requested):
    if requested is not None and old[1]!=requested:
        raise AuthError('STATEMENT_OVERLAP',409)
    return published(old)


def publish_rows(connection,owner,identifier,account,digest,document):
    """One atomic insert of normalized values, preserving every row occurrence."""
    rows=[{'id':str(uuid5(identifier,str(index))),'source_id':digest+':'+str(index),
        'amount_minor':row.amount_minor,'currency':row.currency,'booked_on':row.booked_on.isoformat(),
        'merchant':row.description or 'Unknown counterparty','source_payload_hash':row_sha256(row)}
        for index,row in enumerate(document.rows)]
    connection.execute('''INSERT INTO moneylens.transactions
        (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,
            merchant,category,basket,economic_flow,statement_receipt_id,source_payload_hash)
        SELECT %s,%s,r.id,%s,r.source_id,r.amount_minor,r.currency,r.booked_on,'booked',
            r.merchant,'unclassified','unresolved','unknown',%s,r.source_payload_hash
        FROM jsonb_to_recordset(%s) AS r(id uuid,source_id text,amount_minor bigint,currency text,
            booked_on date,merchant text,source_payload_hash text)''',(*owner,account,identifier,Jsonb(rows)))


@router.post('/v1/statements/wise/preview')
def preview(body:WiseUpload,request:Request,user=Depends(write_principal)):
    return stage_preview(body,request,user,'wise_csv')


@router.post('/v1/statements/preview')
def preview_statement(body:StatementUpload,request:Request,user=Depends(write_principal)):
    return stage_preview(body,request,user,body.format)


def stage_preview(body,request,user,source_format):
    enabled(request)
    try: content=body.csv.encode('utf-8')
    except UnicodeEncodeError: raise AuthError('INVALID_IMPORT_COMMAND',422) from None
    if len(content)>MAX_UPLOAD_BYTES: raise AuthError('IMPORT_TOO_LARGE',413)
    try: data=normalize_statement(content,source_format)
    except (WiseStatementError,StatementNormalizationError): raise AuthError('INVALID_IMPORT_COMMAND',422) from None
    digest=hashlib.sha256(content).hexdigest();owner=(user.scope.tenant_id,user.scope.user_id)
    low,high=data.start,data.end_exclusive
    normalized_digest=data.sha256
    encrypted=cipher(request.app.state.settings,user).encrypt(data.encode())
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            clean(connection,owner)
            old=receipt(connection,owner,digest,normalized_digest)
            if old: return same_destination(old,body.account_id)
            account,label=target_account(connection,owner,body.account_id,source_format)
            check_overlap(connection,owner,account,low,high)
            if connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s',owner).fetchone()[0]>=10:
                raise AuthError('IMPORT_INTAKE_THROTTLED',429)
            now=datetime.now(timezone.utc);identifier=uuid4()
            connection.execute('''INSERT INTO moneylens.statement_previews
                (tenant_id,owner_user_id,id,session_id,file_sha256,account_id,account_label,period_from,period_to_exclusive,
                    encrypted_rows,created_at,expires_at,source_format,normalized_sha256)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (*owner,identifier,user.session_id,digest,account,label[:100],low,high,encrypted,now,
                    now+timedelta(minutes=15),data.source_format,normalized_digest))
    return {'state':'preview','id':str(identifier),'account':label,'account_id':str(account) if account else None,
        'start':low.isoformat(),'end_exclusive':high.isoformat(),'currency':'EUR','count':len(data.rows),
        'repeated_reference_groups':data.repeated_reference_groups,'source_format':data.source_format,
        'account_identity':'unverified','period_basis':'transaction_dates','overlap':'none'}


@router.post('/v1/statements/wise/confirm')
@router.post('/v1/statements/confirm')
def confirm(body:WiseConfirm,request:Request,user=Depends(write_principal)):
    enabled(request);owner=(user.scope.tenant_id,user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            clean(connection,owner)
            existing=connection.execute('''SELECT id,account_id,row_count,period_from,period_to_exclusive,source_format FROM moneylens.statement_import_receipts
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',(*owner,body.preview_id)).fetchone()
            if existing: return published(existing)
            stage=connection.execute('''SELECT session_id,file_sha256,period_from,period_to_exclusive,encrypted_rows,
                account_id,source_format,normalized_sha256
                FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s
                AND expires_at>clock_timestamp()''',(*owner,body.preview_id)).fetchone()
            if not stage or stage[0]!=user.session_id: raise AuthError('NOT_FOUND',404)
            if stage[6] not in PUBLIC_FORMATS: raise AuthError('INVALID_IMPORT_COMMAND',409)
            existing=receipt(connection,owner,stage[1],stage[7])
            if existing:
                result=same_destination(existing,stage[5])
                connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner,body.preview_id))
                return result
            account,label=target_account(connection,owner,stage[5],stage[6])
            check_overlap(connection,owner,account,stage[2],stage[3])
            try: data=decode_normalized(cipher(request.app.state.settings,user).decrypt(bytes(stage[4])))
            except (InvalidToken,StatementNormalizationError): raise AuthError('INVALID_IMPORT_COMMAND',409) from None
            if (data.source_format,data.start,data.end_exclusive)!=(stage[6],stage[2],stage[3]) or (
                stage[7] is not None and data.sha256!=stage[7]):
                raise AuthError('INVALID_IMPORT_COMMAND',409)
            if account is None:
                account=uuid4()
                connection.execute('''INSERT INTO moneylens.accounts
                    (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,%s,'EUR','current')''',(*owner,account,label))
            publish_rows(connection,owner,body.preview_id,account,stage[1],data)
            connection.execute('''INSERT INTO moneylens.statement_import_receipts
                (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count,source_format,normalized_sha256)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (*owner,body.preview_id,account,stage[1],stage[2],stage[3],len(data.rows),data.source_format,data.sha256))
            connection.execute('UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s',owner)
            connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner,body.preview_id))
    return published((body.preview_id,account,len(data.rows),stage[2],stage[3],data.source_format))


def purge_expired_batch(pools, after=None):
    """Sweep a bounded page of owners under their existing RLS scopes."""
    with pools.identity() as connection:
        if after is None:
            owners=connection.execute("SELECT tenant_id,id FROM moneylens.users ORDER BY tenant_id,id LIMIT 100").fetchall()
        else:
            owners=connection.execute("SELECT tenant_id,id FROM moneylens.users WHERE (tenant_id,id)>(%s,%s) ORDER BY tenant_id,id LIMIT 100",after).fetchall()
    for tenant,owner in owners:
        with pools.finance.connection() as connection:
            with tenant_transaction(connection,TrustedScope(tenant,owner)):
                clean(connection,(tenant,owner))
    return owners[-1] if len(owners)==100 else None
