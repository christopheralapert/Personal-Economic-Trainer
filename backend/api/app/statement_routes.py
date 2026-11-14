"""Opt-in, session-bound Wise CSV preview and atomic ledger publication."""
import base64
import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from uuid import UUID, uuid4, uuid5

from cryptography.fernet import Fernet, InvalidToken
from fastapi import APIRouter, Depends, Request
from pydantic import Field, StrictStr
from typing import Annotated
from .auth_routes import write_principal, principal
from .database import TrustedScope, tenant_transaction
from .contracts import Contract
from .identity import AuthError, authorized_transaction
from .statement_wise import preview_wise_csv, WiseStatementError
from . import statement_files

router=APIRouter()

class WiseUpload(Contract):
    csv: Annotated[StrictStr,Field(min_length=1,max_length=65536)]

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


def receipt(connection,owner,digest):
    return connection.execute('''SELECT id,account_id,row_count,period_from,period_to_exclusive FROM moneylens.statement_import_receipts
        WHERE tenant_id=%s AND owner_user_id=%s AND file_sha256=%s''',(*owner,digest)).fetchone()


@router.post('/v1/statements/wise/preview')
def preview(body:WiseUpload | statement_files.FileUpload,request:Request,user=Depends(write_principal)):
    enabled(request)
    if isinstance(body,statement_files.FileUpload):
        return statement_files.preview(body,request,user,cipher,clean,receipt)
    content=body.csv.encode('utf-8')
    if len(content)>65536: raise AuthError('IMPORT_TOO_LARGE',413)
    try: data=preview_wise_csv(content)
    except WiseStatementError: raise AuthError('INVALID_IMPORT_COMMAND',422) from None
    if not data.rows or len(data.rows)>1000: raise AuthError('INVALID_IMPORT_COMMAND',422)
    digest=hashlib.sha256(content).hexdigest();owner=(user.scope.tenant_id,user.scope.user_id)
    low=min(r.booked_on for r in data.rows);high=max(r.booked_on for r in data.rows)+timedelta(days=1)
    rows=[{'date':r.booked_on.isoformat(),'amount':r.amount_minor,'description':r.description} for r in data.rows]
    raw=json.dumps(rows,ensure_ascii=True,separators=(',',':')).encode()
    encrypted=cipher(request.app.state.settings,user).encrypt(raw)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            clean(connection,owner)
            old=receipt(connection,owner,digest)
            if old: return {'state':'published','id':str(old[0]),'account_id':str(old[1]),'count':old[2],'start':old[3].isoformat(),'end_exclusive':old[4].isoformat()}
            if connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts
                WHERE tenant_id=%s AND owner_user_id=%s AND period_from<%s AND period_to_exclusive>%s LIMIT 1''',(*owner,high,low)).fetchone():
                raise AuthError('STATEMENT_OVERLAP',409)
            # A linked Wise bank could later import the same account; identity is not proven.
            if connection.execute('''SELECT 1 FROM moneylens.connections c
                WHERE c.tenant_id=%s AND c.owner_user_id=%s AND c.provider ILIKE '%%wise%%'
                AND c.provider_mode IN ('live','sandbox') LIMIT 1''',owner).fetchone():
                raise AuthError('STATEMENT_OVERLAP',409)
            if connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s',owner).fetchone()[0]>=10:
                raise AuthError('IMPORT_INTAKE_THROTTLED',429)
            now=datetime.now(timezone.utc);identifier=uuid4()
            connection.execute('''INSERT INTO moneylens.statement_previews
                (tenant_id,owner_user_id,id,session_id,file_sha256,account_label,period_from,period_to_exclusive,encrypted_rows,created_at,expires_at)
                VALUES (%s,%s,%s,%s,%s,'Wise CSV',%s,%s,%s,%s,%s)''',(*owner,identifier,user.session_id,digest,low,high,encrypted,now,now+timedelta(minutes=15)))
    return {'state':'preview','id':str(identifier),'account':'Wise CSV','start':low.isoformat(),'end_exclusive':high.isoformat(),'currency':'EUR','count':len(rows),'repeated_reference_groups':data.conflicting_references}


@router.post('/v1/statements/wise/confirm')
def confirm(body:WiseConfirm | statement_files.FileConfirm,request:Request,user=Depends(write_principal)):
    if isinstance(body,statement_files.FileConfirm):
        enabled(request)
        return statement_files.confirm(body,request,user,cipher,clean,receipt)
    enabled(request);owner=(user.scope.tenant_id,user.scope.user_id)
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            clean(connection,owner)
            existing=connection.execute('''SELECT account_id,row_count,period_from,period_to_exclusive FROM moneylens.statement_import_receipts
                WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',(*owner,body.preview_id)).fetchone()
            if existing: return {'state':'published','account_id':str(existing[0]),'count':existing[1],'start':existing[2].isoformat(),'end_exclusive':existing[3].isoformat()}
            stage=connection.execute('''SELECT session_id,file_sha256,period_from,period_to_exclusive,encrypted_rows
                FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s
                AND expires_at>clock_timestamp()''',(*owner,body.preview_id)).fetchone()
            if not stage or stage[0]!=user.session_id: raise AuthError('NOT_FOUND',404)
            existing=receipt(connection,owner,stage[1])
            if existing:
                connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner,body.preview_id))
                return {'state':'published','account_id':str(existing[1]),'count':existing[2],'start':existing[3].isoformat(),'end_exclusive':existing[4].isoformat()}
            if connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
                AND period_from<%s AND period_to_exclusive>%s LIMIT 1''',(*owner,stage[3],stage[2])).fetchone(): raise AuthError('STATEMENT_OVERLAP',409)
            if connection.execute('''SELECT 1 FROM moneylens.connections c
                WHERE c.tenant_id=%s AND c.owner_user_id=%s AND c.provider ILIKE '%%wise%%'
                AND c.provider_mode IN ('live','sandbox') LIMIT 1''',owner).fetchone(): raise AuthError('STATEMENT_OVERLAP',409)
            try: rows=json.loads(cipher(request.app.state.settings,user).decrypt(bytes(stage[4])))
            except (InvalidToken,ValueError): raise AuthError('INVALID_IMPORT_COMMAND',409) from None
            if not isinstance(rows,list) or not 1<=len(rows)<=1000: raise AuthError('INVALID_IMPORT_COMMAND',409)
            previous=connection.execute('''SELECT account_id FROM moneylens.statement_import_receipts
                WHERE tenant_id=%s AND owner_user_id=%s ORDER BY published_at LIMIT 1''',owner).fetchone()
            account=previous[0] if previous else uuid4()
            if not previous: connection.execute('''INSERT INTO moneylens.accounts
                (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Wise CSV','EUR','current')''',(*owner,account))
            for index,row in enumerate(rows):
                source=stage[1]+':'+str(index)
                connection.execute('''INSERT INTO moneylens.transactions
                    (tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow)
                    VALUES (%s,%s,%s,%s,%s,%s,'EUR',%s,'booked',%s,'unclassified','unresolved','unknown')''',
                    (*owner,uuid5(body.preview_id,str(index)),account,source,row['amount'],row['date'],row['description'] or 'Unknown counterparty'))
            connection.execute('''INSERT INTO moneylens.statement_import_receipts
                (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s)''',(*owner,body.preview_id,account,stage[1],stage[2],stage[3],len(rows)))
            connection.execute('UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s',owner)
            connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner,body.preview_id))
    return {'state':'published','account_id':str(account),'count':len(rows),'start':stage[2].isoformat(),'end_exclusive':stage[3].isoformat()}


@router.get('/v1/statements/wise/accounts')
def statement_accounts(request:Request,user=Depends(principal)):
    enabled(request)
    return statement_files.accounts(request,user)


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
