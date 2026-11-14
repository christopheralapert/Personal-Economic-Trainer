"""Multi-format adapter for the existing encrypted preview/publication boundary."""
import base64
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import hashlib
import hmac
import json
from typing import Annotated, Literal
from uuid import UUID, uuid4, uuid5

from cryptography.fernet import InvalidToken
from pydantic import Field, StrictStr
from .contracts import Contract
from .identity import AuthError, authorized_transaction
from .statement_formats import parse_statement, clean
from .statement_wise import WiseStatementError
from .statement_wise import WiseRow
from .statement_publication import publish_rows
from .transaction_classification import Classification,RowReview,load_rules,local_classification,save_rule


class FileUpload(Contract):
    format: Literal['csv','pdf','xlsx','xml','mt940','qif']
    content_base64: Annotated[StrictStr, Field(min_length=1,max_length=2796204)]
    date_order: Literal['day_first','month_first'] | None = None


class FileSelection(Contract):
    preview_id: UUID
    account_id: UUID | None = None
    new_account_label: Annotated[StrictStr,Field(min_length=1,max_length=100)] | None = None
    currency: Literal['EUR'] | None = None
    keep_separate: bool = False
    reviews: list[RowReview] = Field(default_factory=list,max_length=1000)
    classification_token: str | None = Field(default=None,max_length=40000)
    privacy: bool = True


class FileConfirm(Contract):
    previews: Annotated[list[FileSelection],Field(min_length=1,max_length=10)]


def owner(user):
    return user.scope.tenant_id,user.scope.user_id


def pack(value):
    return json.dumps(value,ensure_ascii=True,sort_keys=True,separators=(',',':')).encode()


def fingerprint(rows):
    # The complete multiset includes references, descriptions and occurrence counts.
    # Never deduplicate individual rows by a provider reference or date/amount pair.
    normalized = sorted((r['ref'],' '.join(r['description'].split()),r['date'],r['amount'],'EUR') for r in rows)
    return hashlib.sha256(pack(normalized)).hexdigest()


def account_key(request,user,value):
    if not value: return None
    return hmac.new(request.app.state.settings.session_secret.get_secret_value().encode(),
        pack([str(x) for x in owner(user)]+[value]),hashlib.sha256).hexdigest()


def published(row, identifier=None, added=0):
    return dict(state='published',id=str(identifier or row[0]),account_id=str(row[1]),count=row[2],
        start=row[3].isoformat(),end_exclusive=row[4].isoformat(),last_statement_date=(row[4]-timedelta(days=1)).isoformat(),added_count=added)


def register_legacy(connection,user):
    connection.execute('''INSERT INTO moneylens.statement_accounts(tenant_id,owner_user_id,account_id,last_statement_on)
        SELECT tenant_id,owner_user_id,account_id,max(period_to_exclusive)-1 FROM moneylens.statement_import_receipts
        WHERE tenant_id=%s AND owner_user_id=%s GROUP BY tenant_id,owner_user_id,account_id
        ON CONFLICT(tenant_id,owner_user_id,account_id) DO NOTHING''',owner(user))


def accounts(request,user):
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user):
            rows=connection.execute('''SELECT a.id,a.name,s.last_statement_on FROM moneylens.statement_accounts s
                JOIN moneylens.accounts a ON (a.tenant_id,a.owner_user_id,a.id)=(s.tenant_id,s.owner_user_id,s.account_id)
                WHERE s.tenant_id=%s AND s.owner_user_id=%s ORDER BY a.name,a.id''',owner(user)).fetchall()
    return [dict(id=str(r[0]),name=r[1],currency='EUR',last_statement_date=r[2].isoformat()) for r in rows]


def preview(body,request,user,cipher,clean_expired,receipt):
    try:
        content=base64.b64decode(body.content_base64,validate=True)
        data=parse_statement(content,body.format,body.date_order)
    except WiseStatementError as exc:
        return dict(state='invalid',code=str(exc),format=body.format)
    except ValueError:
        return dict(state='invalid',code='invalid_encoding',format=body.format)
    digest=hashlib.sha256(content).hexdigest()
    key=account_key(request,user,data.account_key)
    rows=[dict(ref=r.reference,date=r.booked_on.isoformat(),amount=r.amount_minor,description=r.description,
        economic_flow=r.economic_flow,source_category=r.source_category,mcc=r.mcc,merchant=r.merchant) for r in data.rows]
    source_format='canonical_csv' if data.variant=='canonical.csv.v1' else 'wise_'+body.format
    payload=dict(rows=rows,key=key,signature=fingerprint(rows),currency=data.currency,variant=data.variant,source_format=source_format)
    start,last=data.start,data.last; end=last+timedelta(days=1)
    label='Wise '+body.format.upper() if not data.account_key else 'Wise ··'+data.account_key[-4:]
    with request.app.state.pools.finance.connection() as connection:
        with authorized_transaction(connection,user,write=True):
            clean_expired(connection,owner(user)); register_legacy(connection,user)
            matched=connection.execute('SELECT account_id FROM moneylens.statement_accounts WHERE tenant_id=%s AND owner_user_id=%s AND key_digest=%s',(*owner(user),key)).fetchone() if key else None
            old=receipt(connection,owner(user),digest,account=matched[0]) if matched else None
            if old:
                signature=connection.execute('SELECT canonical_sha256 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner(user),old[0])).fetchone()[0]
                if signature==payload['signature']: return published(old)
            overlap=connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
                AND period_from<%s AND period_to_exclusive>%s AND (%s::uuid IS NULL OR account_id=%s) LIMIT 1''',
                (*owner(user),end,start,matched[0] if matched else None,matched[0] if matched else None)).fetchone() is not None
            if connection.execute('SELECT count(*) FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s',owner(user)).fetchone()[0]>=10:
                raise AuthError('IMPORT_INTAKE_THROTTLED',429)
            identifier=uuid4(); now=datetime.now(timezone.utc)
            rules=load_rules(connection,owner(user))
            classifications=[local_classification(r,rules) for r in data.rows]
            payload['classifications']=[c.model_dump() for c in classifications]
            encrypted=cipher(request.app.state.settings,user).encrypt(pack(payload))
            if len(encrypted)>500000:return dict(state='invalid',code='file_too_large',format=body.format)
            connection.execute('''INSERT INTO moneylens.statement_previews
                (tenant_id,owner_user_id,id,session_id,file_sha256,account_label,period_from,period_to_exclusive,encrypted_rows,created_at,expires_at,source_format)
                VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                (*owner(user),identifier,user.session_id,digest,label,start,end,encrypted,now,now+timedelta(minutes=15),source_format))
    counts=Counter(r.reference for r in data.rows if r.reference)
    return dict(state='preview',id=str(identifier),account=label,account_id=str(matched[0]) if matched else None,
        requires_account=key is None,currency=data.currency,requires_currency=data.currency is None,
        start=start.isoformat(),end_exclusive=end.isoformat(),last_statement_date=last.isoformat(),count=len(rows),
        repeated_reference_groups=sum(n>1 for n in counts.values()),possible_overlap=overlap,variant=data.variant,
        classifications=[dict(index=i,merchant=r.merchant or r.description,booked_on=r.booked_on.isoformat(),amount_minor=r.amount_minor,
            **c.model_dump(),needs_review=c.needs_review) for i,(r,c) in enumerate(zip(data.rows,classifications))],
        sample=[dict(booked_on=r.booked_on.isoformat(),amount_minor=r.amount_minor,currency='EUR') for r in data.rows[:5]])


def confirm(body,request,user,cipher,clean_expired,receipt):
    if len({p.preview_id for p in body.previews})!=len(body.previews):
        raise AuthError('INVALID_IMPORT_COMMAND',422)
    results=[]; changed=False; created={}
    with request.app.state.pools.finance.connection() as connection:
        # This existing boundary serializes the owned state. The entire batch rolls back
        # if a later file is invalid, expired, foreign, ambiguous, or cannot be linked.
        with authorized_transaction(connection,user,write=True):
            clean_expired(connection,owner(user)); register_legacy(connection,user)
            if connection.execute('''SELECT 1 FROM moneylens.connections WHERE tenant_id=%s AND owner_user_id=%s
                AND provider ILIKE '%%wise%%' AND provider_mode IN ('live','sandbox') LIMIT 1''',owner(user)).fetchone():
                raise AuthError('STATEMENT_OVERLAP',409)
            for selection in body.previews:
                existing=connection.execute('''SELECT id,account_id,row_count,period_from,period_to_exclusive
                    FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s''',(*owner(user),selection.preview_id)).fetchone()
                if existing:
                    if selection.account_id and selection.account_id!=existing[1]:
                        raise AuthError('STATEMENT_ACCOUNT_MISMATCH',409)
                    results.append(published(existing)); continue
                stage=connection.execute('''SELECT session_id,file_sha256,period_from,period_to_exclusive,encrypted_rows,account_label
                    FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s
                    AND expires_at>clock_timestamp()''',(*owner(user),selection.preview_id)).fetchone()
                if not stage or stage[0]!=user.session_id: raise AuthError('NOT_FOUND',404)
                try: payload=json.loads(cipher(request.app.state.settings,user).decrypt(bytes(stage[4])))
                except (InvalidToken,ValueError): raise AuthError('INVALID_IMPORT_COMMAND',409) from None
                if not isinstance(payload,dict) or 'variant' not in payload: raise AuthError('INVALID_IMPORT_COMMAND',409)
                if payload['currency'] is None and selection.currency!='EUR': raise AuthError('STATEMENT_CURRENCY_REQUIRED',422)
                key=payload['key']; account=selection.account_id
                bound=connection.execute('SELECT account_id FROM moneylens.statement_accounts WHERE tenant_id=%s AND owner_user_id=%s AND key_digest=%s',(*owner(user),key)).fetchone() if key else None
                if bound:
                    if account and account!=bound[0]: raise AuthError('STATEMENT_ACCOUNT_MISMATCH',409)
                    account=bound[0]
                if selection.new_account_label and account: raise AuthError('STATEMENT_ACCOUNT_MISMATCH',409)
                if not account:
                    if not key and not selection.new_account_label: raise AuthError('STATEMENT_ACCOUNT_REQUIRED',422)
                    try: label=clean(selection.new_account_label or stage[5],100)
                    except WiseStatementError: raise AuthError('INVALID_IMPORT_COMMAND',422) from None
                    if not label: raise AuthError('STATEMENT_ACCOUNT_REQUIRED',422)
                    # A shared, explicit new-account choice within this batch is one account.
                    account=created.get(label) if selection.new_account_label else None
                    if not account:
                        account=uuid4()
                        connection.execute('''INSERT INTO moneylens.accounts(tenant_id,owner_user_id,id,name,currency,account_type)
                            VALUES(%s,%s,%s,%s,'EUR','current')''',(*owner(user),account,label))
                        connection.execute('''INSERT INTO moneylens.statement_accounts(tenant_id,owner_user_id,account_id,key_digest,last_statement_on)
                            VALUES(%s,%s,%s,%s,%s)''',(*owner(user),account,key,stage[3]-timedelta(days=1)))
                        if selection.new_account_label: created[label]=account
                selected=connection.execute('SELECT key_digest FROM moneylens.statement_accounts WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s',(*owner(user),account)).fetchone()
                if selected is None: raise AuthError('NOT_FOUND',404)
                if key and selected[0] and key!=selected[0]: raise AuthError('STATEMENT_ACCOUNT_MISMATCH',409)
                old=receipt(connection,owner(user),stage[1],account=account)
                if old:
                    signature=connection.execute('SELECT canonical_sha256 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner(user),old[0])).fetchone()[0]
                    legacy_fixed_csv=(signature is None and old[5] in ('wise_csv','canonical_csv')
                        and payload['variant'] in ('wise.csv.transferwise-id.v1','canonical.csv.v1'))
                    if signature!=payload['signature'] and not legacy_fixed_csv:
                        raise AuthError('STATEMENT_OVERLAP',409)
                    connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner(user),selection.preview_id))
                    results.append(published(old)); continue
                signature=payload['signature']; rows=payload['rows']
                same=all(r['ref'] for r in rows) and connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
                    AND account_id=%s AND canonical_sha256=%s LIMIT 1''',(*owner(user),account,signature)).fetchone()
                overlap=connection.execute('''SELECT 1 FROM moneylens.statement_import_receipts WHERE tenant_id=%s AND owner_user_id=%s
                    AND account_id=%s AND period_from<%s AND period_to_exclusive>%s LIMIT 1''',(*owner(user),account,stage[3],stage[2])).fetchone()
                if not same and overlap and not selection.keep_separate: raise AuthError('STATEMENT_OVERLAP',409)
                added=0 if same else len(rows)
                if not same:
                    from .statement_classification import selected_classifications
                    classifications=selected_classifications(payload,selection,request,user,cipher)
                    for review in selection.reviews:
                        if review.remember_merchant:
                            try:save_rule(connection,owner(user),rows[review.index].get('merchant') or rows[review.index]['description'],classifications[review.index])
                            except ValueError:raise AuthError('INVALID_IMPORT_COMMAND',422) from None
                    publish_rows(connection,owner(user),selection.preview_id,account,stage[1],
                        [WiseRow(r['ref'],date.fromisoformat(r['date']),r['amount'],'EUR',r['description'],
                            r.get('economic_flow'),r.get('source_category'),r.get('mcc'),r.get('merchant')) for r in rows],classifications)
                    changed=True
                connection.execute('''INSERT INTO moneylens.statement_import_receipts
                    (tenant_id,owner_user_id,id,account_id,file_sha256,period_from,period_to_exclusive,row_count,canonical_sha256,source_format)
                    VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',(*owner(user),selection.preview_id,account,stage[1],stage[2],stage[3],len(rows),signature,payload.get('source_format','wise_csv')))
                connection.execute('''UPDATE moneylens.statement_accounts SET key_digest=coalesce(key_digest,%s),last_statement_on=greatest(last_statement_on,%s)
                    WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s''',(key,stage[3]-timedelta(days=1),*owner(user),account))
                connection.execute('DELETE FROM moneylens.statement_previews WHERE tenant_id=%s AND owner_user_id=%s AND id=%s',(*owner(user),selection.preview_id))
                results.append(published((selection.preview_id,account,len(rows),stage[2],stage[3]),added=added))
            if changed: connection.execute('UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s',owner(user))
    return dict(state='published',files=results,added_count=sum(r['added_count'] for r in results))
