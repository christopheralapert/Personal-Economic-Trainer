import base64
from uuid import uuid4
from fastapi.testclient import TestClient
from app.main import create_app
from app.settings import Settings
from app.demo_statements import SAMPLE
from scripts.generate_classification_fixtures import TAXIS
from scripts.generate_wise_fixtures import bundle

def client():
    return TestClient(create_app(Settings(auth_enabled=False,app_origin='http://testserver')))

def begin(c):
    response=c.post('/v1/demo-statements/session',headers={'origin':'http://testserver'})
    assert response.status_code==200
    return {'origin':'http://testserver','x-csrf-token':response.json()['csrf_token']}

def preview(c,headers,content=SAMPLE):
    return c.post('/v1/demo-statements/statements/wise/preview',headers=headers,json={'format':'csv','content_base64':base64.b64encode(content).decode()})

def test_sample_is_existing_fixture_and_shared_rules_classify_both_rows():
    assert SAMPLE==bundle(rows=TAXIS)['csv']
    with client() as c:
        headers=begin(c);p=preview(c,headers).json()
        assert p['count']==2 and p['currency']=='EUR'
        assert [row['category'] for row in p['classifications']]==['taxi','taxi']
        assert all(row['basis']=='source_rule' and not row['needs_review'] for row in p['classifications'])
        body={'previews':[{'preview_id':p['id']}]}
        assert c.post('/v1/demo-statements/statements/wise/confirm',headers=headers,json=body).json()['added_count']==2
        assert c.post('/v1/demo-statements/statements/wise/confirm',headers=headers,json=body).json()['added_count']==0
        p2=preview(c,headers).json()
        assert c.post('/v1/demo-statements/statements/wise/confirm',headers=headers,json={'previews':[{'preview_id':p2['id']}]}).json()['added_count']==0
        profile=c.get('/v1/demo-statements/dataset').json()['profiles'][0]
        assert len(profile['transactions'])==2 and sum(r['amount_minor'] for r in profile['transactions'])==-3097

def test_session_isolation_batch_rollback_and_synthetic_only_boundary():
    app=create_app(Settings(auth_enabled=False,app_origin='http://testserver'))
    with TestClient(app) as a,TestClient(app) as b:
        ah,bh=begin(a),begin(b);p=preview(a,ah).json()
        foreign={'previews':[{'preview_id':p['id']}]}
        assert b.post('/v1/demo-statements/statements/wise/confirm',headers=bh,json=foreign).status_code==404
        mixed={'previews':[{'preview_id':p['id']},{'preview_id':str(uuid4())}]}
        assert a.post('/v1/demo-statements/statements/wise/confirm',headers=ah,json=mixed).status_code==404
        assert a.get('/v1/demo-statements/dataset').status_code==404
        assert a.post('/v1/demo-statements/statements/wise/confirm',headers=ah,json=foreign).json()['added_count']==2
        assert b.get('/v1/demo-statements/dataset').status_code==404
        # Visitors may try their own EUR statement; it stays in their session only.
        own=preview(b,bh,SAMPLE.replace(b'15.97',b'99.97')).json()
        assert own['state']=='preview' and own['account']=='Your statement' and own['count']==2
        assert preview(b,bh,b'not,a,statement'+bytes([10])+b'1,2,3'+bytes([10])).json()['state']=='invalid'
        assert b.get('/v1/demo-statements/dataset').status_code==404
        assert preview(a,{'origin':'http://testserver'}).status_code==403
        assert a.post('/v1/demo-statements/session',headers={'origin':'https://other.example'}).status_code==403
        assert a.get('/v1/demo-statements/sample/auto-taxis.csv').content==SAMPLE

def test_saved_manual_classification_survives_repeat_and_session_expiry_clears_data():
    with client() as c:
        h=begin(c);p=preview(c,h).json()
        command={'previews':[{'preview_id':p['id'],'reviews':[{'index':0,'economic_flow':'expense','category':'dining'}]}]}
        assert c.post('/v1/demo-statements/statements/wise/confirm',headers=h,json=command).json()['added_count']==2
        second=preview(c,h).json()
        assert c.post('/v1/demo-statements/statements/wise/confirm',headers=h,json={'previews':[{'preview_id':second['id']}]}).json()['added_count']==0
        assert c.get('/v1/demo-statements/dataset').json()['profiles'][0]['transactions'][0]['category']=='dining'
        token=c.cookies.get('moneycoach_demo_import');c.app.state.demo_statements[token].expires=0
        assert c.get('/v1/demo-statements/dataset').status_code==401
        begin(c);assert c.get('/v1/demo-statements/dataset').status_code==404
