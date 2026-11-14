"""Anonymous synthetic-file rehearsal. Normalized rows live only in bounded sessions."""
import base64
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import timedelta
import secrets
from time import monotonic
from uuid import uuid4

from fastapi import APIRouter, Request
from fastapi.responses import Response, JSONResponse
from .identity import AuthError
from .statement_files import FileUpload, FileConfirm, published
from .statement_formats import parse_statement
from .transaction_classification import local_classification

router = APIRouter(prefix='/v1/demo-statements')
COOKIE = 'moneycoach_demo_import'
# Same two synthetic purchases as scripts.generate_classification_fixtures.TAXIS.
SAMPLE = ('TransferWise ID,Date,Amount,Currency,Description\r\n'
          'CARD-AUTO-1,03-10-2026,-15.00,EUR,BOLT *RIDE\r\n'
          'CARD-AUTO-2,03-10-2026,-15.97,EUR,BOLT *RIDE\r\n').encode()

@dataclass
class DemoSession:
    csrf: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    expires: float = field(default_factory=lambda: monotonic()+3600)
    previews: dict = field(default_factory=dict)
    receipts: dict = field(default_factory=dict)
    account: str = field(default_factory=lambda: str(uuid4()))
    rows: list = field(default_factory=list)
    previews_created: int = 0

def store(request):
    # Per application, never shared with the authenticated ledger or user rules.
    return request.app.state.demo_statements

def origin(request):
    if request.headers.get('origin') != request.app.state.settings.app_origin or request.headers.get('sec-fetch-site') == 'cross-site':
        raise AuthError('ORIGIN_REJECTED',403)

def session(request, write=False):
    token=request.cookies.get(COOKIE,'')
    with request.app.state.demo_statement_lock:
        state=store(request).get(token)
        if not state or state.expires<=monotonic():
            store(request).pop(token,None)
            raise AuthError('DEMO_SESSION_EXPIRED',401)
        if write:
            origin(request)
            csrf=request.headers.get('x-csrf-token','')
            if not csrf.isascii() or not secrets.compare_digest(csrf,state.csrf):
                raise AuthError('CSRF_REJECTED',403)
        return state

@router.get('/sample/auto-taxis.csv')
def sample():
    return Response(SAMPLE,media_type='text/csv',headers={'Content-Disposition':'attachment; filename="auto-taxis.csv"'})

@router.post('/session')
def start(request:Request):
    origin(request)
    with request.app.state.demo_statement_lock:
        sessions=store(request)
        for token in list(sessions):
            if sessions[token].expires<=monotonic(): del sessions[token]
        token=request.cookies.get(COOKIE,'')
        state=sessions.get(token)
        if state is None:
            if len(sessions)>=100:raise AuthError('IMPORT_INTAKE_THROTTLED',429)
            token=secrets.token_urlsafe(32);state=DemoSession();sessions[token]=state
        result=JSONResponse({'csrf_token':state.csrf,'expires_in':max(0,int(state.expires-monotonic()))})
        result.set_cookie(COOKIE,token,httponly=True,samesite='strict',secure=request.app.state.settings.app_origin.startswith('https:'),max_age=3600,path='/')
        return result

@router.get('/statements/wise/accounts')
def accounts(request:Request):
    state=session(request)
    return [] if not state.rows else [{'id':state.account,'name':'Synthetic taxis','currency':'EUR','last_statement_date':'2026-10-03'}]

@router.post('/statements/wise/preview')
def preview(body:FileUpload,request:Request):
    state=session(request,True)
    try:content=base64.b64decode(body.content_base64,validate=True)
    except ValueError:raise AuthError('INVALID_IMPORT_COMMAND',422) from None
    # Public practice accepts the supplied synthetic fixture only. Real uploads
    # use the authenticated importer, never this anonymous endpoint.
    if body.format!='csv' or content.replace(b'\r\n',b'\n')!=SAMPLE.replace(b'\r\n',b'\n'):
        return {'state':'invalid','code':'synthetic_sample_required'}
    with request.app.state.demo_statement_lock:
        if len(state.previews)>=10 or state.previews_created>=100:raise AuthError('IMPORT_INTAKE_THROTTLED',429)
        document=parse_statement(content,body.format,body.date_order)
        classifications=[local_classification(row) for row in document.rows]
        identifier=str(uuid4());state.previews[identifier]=(document,classifications);state.previews_created+=1
        return dict(state='preview',id=identifier,account='Synthetic taxis',account_id=state.account if state.rows else None,
            requires_account=False,currency='EUR',requires_currency=False,start=document.start.isoformat(),
            end_exclusive=(document.last+timedelta(days=1)).isoformat(),last_statement_date=document.last.isoformat(),
            count=len(document.rows),repeated_reference_groups=0,possible_overlap=bool(state.rows),
            sample=[dict(booked_on=row.booked_on.isoformat(),amount_minor=row.amount_minor,currency='EUR') for row in document.rows],
            classifications=[dict(index=i,booked_on=row.booked_on.isoformat(),amount_minor=row.amount_minor,
                merchant=row.merchant or row.description,**c.model_dump(),needs_review=c.needs_review) for i,(row,c) in enumerate(zip(document.rows,classifications))])

@router.post('/statements/wise/confirm')
def confirm(body:FileConfirm,request:Request):
    state=session(request,True)
    with request.app.state.demo_statement_lock:
        # Validate the whole batch before mutating anything, including repeat submits.
        planned=[]
        if len({p.preview_id for p in body.previews})!=len(body.previews):raise AuthError('INVALID_IMPORT_COMMAND',422)
        for selected in body.previews:
            identifier=str(selected.preview_id)
            if selected.account_id and str(selected.account_id)!=state.account:raise AuthError('NOT_FOUND',404)
            if identifier in state.receipts:planned.append((identifier,None,None));continue
            if identifier not in state.previews:raise AuthError('NOT_FOUND',404)
            document,original=state.previews[identifier];values=list(original);seen=set()
            for review in selected.reviews:
                if review.index in seen or review.index>=len(values):raise AuthError('INVALID_IMPORT_COMMAND',422)
                seen.add(review.index)
                try:values[review.index]=review.classification(document.rows[review.index].amount_minor)
                except ValueError:raise AuthError('INVALID_IMPORT_COMMAND',422) from None
            planned.append((identifier,document,values))
        results=[]
        for identifier,document,values in planned:
            if document is None:results.append({**state.receipts[identifier],'added_count':0});continue
            added=0 if state.rows else len(document.rows)
            if added:
                state.rows=[dict(id=str(uuid4()),account_id=state.account,amount_minor=row.amount_minor,currency='EUR',
                    booked_on=row.booked_on.isoformat(),merchant=row.merchant or row.description,
                    economic_flow=c.economic_flow if c.economic_flow in ('expense','refund','income','internal_transfer') else 'internal_transfer',
                    category=c.category or 'unclassified',basket=c.basket,status='booked',basket_basis='user_review' if c.basis=='user_rule' else 'everyday_purchase')
                    for row,c in zip(document.rows,values)]
            result=published((identifier,state.account,len(document.rows),document.start,document.last+timedelta(days=1)),added=added)
            state.receipts[identifier]=result;state.previews.pop(identifier,None);results.append(result)
        return {'state':'published','files':results,'added_count':sum(r['added_count'] for r in results)}

@router.get('/dataset')
def dataset(request:Request):
    state=session(request)
    with request.app.state.demo_statement_lock:
        if not state.rows:raise AuthError('NOT_FOUND',404)
        return {'notice':'Synthetic statement practice; expires with this isolated demo session.','profiles':[dict(
            as_of='2026-11-14T12:00:00+02:00',name='Synthetic statement practice',mode='synthetic',
            accounts=[dict(id=state.account,name='Synthetic taxis',currency='EUR',included=True)],transactions=deepcopy(state.rows),
            balances=[],bills_minor=0,essentials_minor=0,buffer_minor=0)]}
