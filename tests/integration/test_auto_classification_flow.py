"""Real PostgreSQL/RLS and native Gemini test transport around owned staged rows."""
import base64
import json
from uuid import uuid4
import httpx
import psycopg
from identity_support import authenticated_app,login,ORIGIN
from scripts.generate_wise_fixtures import bundle
from app.gemini_adapter import GeminiFunctions

ROWS=(('CARD-1','03-10-2026','-15.00','BOLT *RIDE'),('CARD-2','03-10-2026','-15.97','BOLT *RIDE'),
    ('CARD-3','04-10-2026','-4.00','STARBUCKS OY'),('CARD-4','04-10-2026','-2.00','Starbucks Ltd'),
    ('TRANSFER-5','04-10-2026','-50.00','BOLT *RIDE'))

def headers(client,profile='aino'):
    s=login(client,profile).json();return {'Origin':ORIGIN,'X-CSRF-Token':s['csrf_token']}
def stage(client,h,format='csv',rows=ROWS):
    r=client.post('/v1/statements/wise/preview',headers=h,json={'format':format,'content_base64':base64.b64encode(bundle(rows=rows)[format]).decode()})
    assert r.status_code==200;return r.json()
def confirm(client,h,p,**extras):
    return client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[{'preview_id':p['id'],'new_account_label':'Synthetic automatic',**extras}]})
def mock_model(config,calls,fault=False):
    def reply(request):
        body=json.loads(request.content);data=json.loads(body['contents'][0]['parts'][0]['text']);calls.append(data)
        assert data['merchants']==[{'ref':'m0','merchant':'STARBUCKS'}]
        args={'batch_ref':data['batch_ref'],'items':[{'ref':'m0','category':'coffee'}]}
        if fault:args['batch_ref']='0'*32
        return httpx.Response(200,json={'candidates':[{'content':{'parts':[{'functionCall':{'name':'classify_merchants','args':args}}]},'finishReason':'STOP'}],
            'usageMetadata':{'promptTokenCount':100,'candidatesTokenCount':20,'totalTokenCount':120}})
    return GeminiFunctions(config,transport=httpx.MockTransport(reply))

def test_preview_confirm_same_saved_categories_owner_rules_and_dedup(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client);p=stage(client,h)
        assert [r['category'] for r in p['classifications']]==['taxi','taxi',None,None,None]
        assert p['classifications'][-1]['economic_flow']=='unknown'
        saved=confirm(client,h,p,reviews=[{'index':2,'economic_flow':'expense','category':'coffee','remember_merchant':True}]);assert saved.status_code==200
        account=saved.json()['files'][0]['account_id']
        with psycopg.connect(database['admin']) as db:
            rows=db.execute('SELECT category,economic_flow,classification_basis,amount_minor FROM moneylens.transactions WHERE owner_user_id=%s ORDER BY source_id',(owners[0][1],)).fetchall()
            assert rows[:3]==[('taxi','expense','source_rule',-1500),('taxi','expense','source_rule',-1597),('coffee','expense','user_rule',-400)]
        p=stage(client,h,'xlsx');repeat=client.post('/v1/statements/wise/confirm',headers=h,json={'previews':[{'preview_id':p['id'],'account_id':account}]})
        assert repeat.status_code==200 and repeat.json()['added_count']==0
        later=stage(client,h,rows=(('CARD-NEW','12-11-2026','-3.00','STARBUCKS OY'),))
        assert later['classifications'][0]['category']=='coffee' and later['classifications'][0]['basis']=='user_rule'
        b=headers(client,'mika');other=stage(client,b,rows=(('CARD-OTHER','12-11-2026','-3.00','STARBUCKS OY'),))
        assert other['classifications'][0]['category'] is None
        assert client.post('/v1/statements/wise/classify',headers=b,json={'preview_ids':[later['id']],'privacy':True}).status_code==404

def test_cloud_privacy_signed_proposals_manual_priority_and_saved_totals(database,owners):
    options=dict(statement_imports_enabled=True,statement_cloud_classification_enabled=True,model_enabled=True,
        model_provider='gemini',model_name='gemini-3.5-flash',gemini_api_key='synthetic-key',model_billing_policy='paid_allowed',
        model_input_microusd_per_token=1,model_output_microusd_per_token=5)
    with authenticated_app(database,owners,**options) as (client,app,config):
        calls=[];app.state.model=mock_model(config,calls);h=headers(client);p=stage(client,h)
        for body in [{'privacy':True,'cloud_consent':True},{'privacy':False,'cloud_consent':False}]:
            assert client.post('/v1/statements/wise/classify',headers=h,json={'preview_ids':[p['id']],**body}).json()['model_calls']==0
        assert calls==[]
        response=client.post('/v1/statements/wise/classify',headers=h,json={'preview_ids':[p['id']],'privacy':False,'cloud_consent':True})
        assert response.status_code==200;proposal=response.json()['previews'][0]
        assert proposal['suggestions']==[{'index':2,'category':'coffee'},{'index':3,'category':'coffee'}] and len(calls)==1
        assert confirm(client,h,p,privacy=False,classification_token='forged').status_code==422
        result=confirm(client,h,p,privacy=False,classification_token=proposal['token'],reviews=[{'index':2,'economic_flow':'expense','category':'dining'}])
        assert result.status_code==200
        with psycopg.connect(database['admin']) as db:
            rows=db.execute('SELECT category,classification_basis FROM moneylens.transactions WHERE owner_user_id=%s ORDER BY source_id',(owners[0][1],)).fetchall()
            assert rows[2:4]==[('dining','user_rule'),('coffee','gemini')]
        # A valid late proposal is ignored when confirmation has privacy on.
        p2=stage(client,h,rows=(('CARD-NEW','12-11-2026','-3.00','STARBUCKS OY'),))
        response=client.post('/v1/statements/wise/classify',headers=h,json={'preview_ids':[p2['id']],'privacy':False,'cloud_consent':True}).json()
        assert confirm(client,h,p2,privacy=True,classification_token=response['previews'][0]['token']).status_code==200
        with psycopg.connect(database['admin']) as db:
            assert db.execute("SELECT category FROM moneylens.transactions WHERE owner_user_id=%s AND amount_minor=-300",(owners[0][1],)).fetchone()==('unclassified',)

def test_preclassification_schema_upgrades_without_changing_saved_facts(migration_database):
    from alembic import command
    with migration_database('0028_merge_identity_statements') as database:
        tid,uid,aid,rid=(uuid4() for _ in range(4))
        with psycopg.connect(database['admin']) as db:
            db.execute("INSERT INTO moneylens.tenants(id,name) VALUES(%s,'Synthetic')",(tid,))
            db.execute("INSERT INTO moneylens.users(tenant_id,id,subject_issuer,subject_id) VALUES(%s,%s,'synthetic','before')",(tid,uid))
            db.execute("INSERT INTO moneylens.accounts(tenant_id,owner_user_id,id,name,currency,account_type) VALUES(%s,%s,%s,'Synthetic','EUR','current')",(tid,uid,aid))
            db.execute("""INSERT INTO moneylens.transactions(tenant_id,owner_user_id,id,account_id,source_id,amount_minor,currency,booked_on,status,merchant,category,basket,economic_flow)
                VALUES(%s,%s,%s,%s,'synthetic',-3097,'EUR','2026-10-03','booked','Synthetic','taxi','everyday','expense')""",(tid,uid,rid,aid))
        with database['engine'].begin() as connection:
            database['config'].attributes['connection']=connection;command.upgrade(database['config'],'head')
        with psycopg.connect(database['admin']) as db:
            assert db.execute('SELECT id,account_id,amount_minor,category,economic_flow,classification_basis FROM moneylens.transactions').fetchone()==(rid,aid,-3097,'taxi','expense','source_rule')
            assert db.execute('SELECT version_num FROM alembic_version').fetchone()==('0029_automatic_classification',)


def test_separate_merchant_field_survives_publication_for_private_rules(database,owners):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        h=headers(client)
        csv=('TransferWise ID,Date,Amount,Currency,Description,Merchant,Details Type\n'
             'CARD-ONE,03-10-2026,-4.00,EUR,Synthetic private memo,STARBUCKS OY,CARD\n')
        p=client.post('/v1/statements/wise/preview',headers=h,json={'format':'csv','content_base64':base64.b64encode(csv.encode()).decode()}).json()
        assert p['classifications'][0]['merchant']=='STARBUCKS OY'
        assert confirm(client,h,p,reviews=[{'index':0,'economic_flow':'expense','category':'coffee','remember_merchant':True}]).status_code==200
        with psycopg.connect(database['admin']) as db:
            assert db.execute('SELECT merchant,category FROM moneylens.transactions WHERE owner_user_id=%s',(owners[0][1],)).fetchone()==('STARBUCKS OY','coffee')
        csv=csv.replace('CARD-ONE','CARD-TWO').replace('03-10-2026','12-11-2026').replace('Synthetic private memo','Another private memo')
        p=client.post('/v1/statements/wise/preview',headers=h,json={'format':'csv','content_base64':base64.b64encode(csv.encode()).decode()}).json()
        assert p['classifications'][0]['basis']=='user_rule' and p['classifications'][0]['category']=='coffee'
