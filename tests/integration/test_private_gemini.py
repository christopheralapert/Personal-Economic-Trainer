"""Real owner/RLS/tools with native Gemini's injected HTTP transport, never a live key."""
from itertools import count
import json
from types import SimpleNamespace

from fastapi.testclient import TestClient
import httpx
import psycopg
import pytest

from app import coach_routes
from app.auth_routes import cookie_name
from app.main import create_app
from app.model_adapter import build_model
from app.settings import Settings
from test_bank_routes import NOW
from test_ledger import put

ORIGIN='http://127.0.0.1:3000'
PERIOD=dict(start='2026-10-01',end_exclusive='2026-11-01')
QUESTIONS={
 'en':['Could you find my October transactions?','Please check my taxi costs for October.','Compare my October taxi spending with the previous month.','And September?','What if I cut dining out by 20% in October?','What can I safely save this month?'],
 'fi':['Voisitko etsiä lokakuun tapahtumani?','Tarkistaisitko lokakuun taksikuluni?','Vertaa lokakuun taksikuluja edelliseen kuukauteen.','Entä syyskuussa?','Entä jos vähennän ravintolakuluja 20% lokakuussa?','Paljonko voin säästää turvallisesti tässä kuussa?'],
 'et':['Kas leiad mu oktoobri tehingud?','Palun vaata üle mu oktoobri taksokulud.','Võrdle oktoobri taksokulu eelmise kuuga.','Aga septembris?','Mis oleks, kui vähendaksin oktoobri restoranikulusid 20%?','Kui palju võin sel kuul turvaliselt säästa?'],
}


@pytest.mark.parametrize('locale',QUESTIONS)
def test_native_model_selected_tools_use_owned_rows_and_never_send_ledger_data(database,owners,monkeypatch,locale):
    ticks=count(1000,60);monkeypatch.setattr(coach_routes,'time',SimpleNamespace(monotonic=lambda:next(ticks)))
    with psycopg.connect(database['admin']) as connection:
        first=put(connection,owners[0],amount=-1234,category='taxi',merchant='Private merchant sentinel')
        put(connection,owners[0],amount=234,flow='refund',category='taxi')
        put(connection,owners[0],amount=-500,category='taxi',day='2026-09-15')
        put(connection,owners[0],amount=-25000,category='dining')
        foreign=put(connection,owners[1],amount=-999999,category='taxi')
    config=Settings(environment='test',auth_enabled=True,app_origin=ORIGIN,database_url=database['runtime'],auth_database_url=database['auth'],
        session_secret='native-gemini-test-only-at-least-32-characters',model_enabled=True,model_provider='gemini',model_name='gemini-3.5-flash',
        model_billing_policy='paid_allowed',gemini_api_key='injected-transport-only',model_input_microusd_per_token=1,model_output_microusd_per_token=5)
    app=create_app(config);captured=[];selected={}
    def handle(request):
        assert str(request.url).endswith('/models/gemini-3.5-flash:generateContent')
        captured.append(json.loads(request.content))
        composing=captured[-1]['tools'][0]['functionDeclarations'][0]['name']=='respond_to_money_message'
        conversation=selected.get('intent')=='conversation'
        text='Choose meals that share ingredients, then make a shopping list.' if conversation else 'Review the evidence and choose a manageable next step.'
        call=dict(name='respond_to_money_message',args=dict(text=text)) if composing or conversation else dict(name='interpret_money_question',args=selected.copy())
        return httpx.Response(200,json=dict(candidates=[dict(finishReason='STOP',content=dict(parts=[dict(functionCall=call)]))],usageMetadata=dict(promptTokenCount=100,candidatesTokenCount=100,totalTokenCount=200)))
    with TestClient(app,base_url=ORIGIN) as client:
        client.portal.call(app.state.model.close);app.state.model=build_model(config,transport=httpx.MockTransport(handle));app.state.coach_clock=lambda:NOW
        def login(index=0):
            token=app.state.identity.login('integration',str(owners[index][1]));client.cookies.clear();client.cookies.set(cookie_name(config),token)
            session=client.get('/v1/auth/session').json()
            return {'Origin':ORIGIN,'X-CSRF-Token':session['csrf_token'],'X-MoneyLens-Session-ID':session['session_id']}
        auth=login();answers=[]
        intents=['transactions','spending','comparison','spending','reduction','planning']
        for index,(question,intent) in enumerate(zip(QUESTIONS[locale],intents,strict=True)):
            selected.clear();selected.update(dict(intent=intent,**PERIOD,category='taxi' if index in (1,2,3) else 'dining' if index==4 else None,
                merchant=None,reduction_basis_points=2000 if index==4 else None,comparison_mode='previous_month' if index==2 else None))
            if index==3:selected.update(start='2026-09-01',end_exclusive='2026-10-01')
            if intent=='planning':selected.update(start=None,end_exclusive=None)
            context=json.dumps(dict(tool='spending_totals',**PERIOD,category='taxi')) if index==3 else None
            history=[{'role':'user','text':'I want to make taxi trips less frequent.'},
                {'role':'assistant','text':'Review the recorded trips before choosing a change.'},
                {'role':'user','text':str(owners[1][2])}] if index==1 else []
            before=len(captured)
            response=client.post('/v1/coach/query',headers=auth,json=dict(question=question,privacy=False,card_locale=locale,account_ids=[str(owners[0][2])],conversation_context=context,conversation_history=history))
            assert response.status_code==200,response.text
            body=response.json();answers.append(body)
            assert body['source']=='model' and body['provider']=='gemini-direct' and body['model_diagnostic'] is None,(index,body['model_diagnostic'],body['interpretation'])
            assert response.headers['X-Money-Coach-Source']=='model' and response.headers['X-Money-Coach-Provider']=='gemini-direct'
            assert response.headers['Server-Timing'].startswith('model;dur=')
            assert body['model_usage']['calls']==(1 if intent=='planning' else 2) and body['model_usage']['usage_complete'] is True
            if intent!='planning':assert body['answer_text'].startswith('Review the evidence and choose a manageable next step.\n\n')
            if history:
                for payload in captured[before:]:
                    import_history=json.loads(payload['contents'][0]['parts'][0]['text'])
                    assert import_history['untrusted_dialogue']==history[:2]
        assert len(answers[0]['transactions']['rows'])==3
        assert answers[1]['card']['answer']['artifact']['result']['net_minor']==1000
        assert answers[2]['card']['answer']['artifact']['result']['change']['net_minor']==500
        assert answers[3]['card']['answer']['artifact']['result']['net_minor']==500
        assert answers[4]['card']['answer']['status']=='blocked'  # No invented source completeness.
        assert answers[5]['interpretation']['reason']=='PLANNING_REVIEW_REQUIRED' and answers[5]['card'] is None
        selected.clear();selected['intent']='conversation'
        history=[{'role':'user','text':'I want help with meal planning and grocery costs.'},
            {'role':'assistant','text':'Start by reviewing the ingredients you already have.'}]
        general=client.post('/v1/coach/query',headers=auth,json=dict(question='Could you explain that more?',privacy=False,
            card_locale=locale,conversation_history=history)).json()
        assert general['source']=='model' and general['interpretation']['status']=='answered'
        assert general['model_usage']['calls']==1 and general['card'] is general['transactions'] is general['habits'] is None
        assert 'meals that share ingredients' in general['answer_text']
        assert json.loads(captured[-1]['contents'][0]['parts'][0]['text'])['untrusted_dialogue']==history
        before=len(captured)
        local=client.post('/v1/coach/query',headers=auth,json=dict(question={'en':'How much did I spend on taxis last month?','fi':'Paljonko käytin takseihin viime kuussa?','et':'Kui palju kulutasin taksodele eelmisel kuul?'}[locale],privacy=True,card_locale=locale))
        assert local.status_code==200 and local.json()['source']=='rule' and local.json()['provider'] is None and len(captured)==before
        wire=json.dumps(captured)
        for forbidden in ('Private merchant sentinel',str(first),str(foreign),str(owners[0][2]),str(owners[1][2]),'injected-transport-only'):
            assert forbidden not in wire
        # A request cannot retrieve another user's account with a model-selected filter.
        selected.update(intent='spending',**PERIOD,category='taxi',merchant=None,reduction_basis_points=None,comparison_mode=None)
        assert client.post('/v1/coach/query',headers=auth,json=dict(question=QUESTIONS[locale][1],privacy=False,account_ids=[str(owners[1][2])])).status_code==404
        other=login(1)
        response=client.post('/v1/coach/query',headers=other,json=dict(question=QUESTIONS[locale][1],privacy=False,card_locale=locale))
        assert response.status_code==200 and response.json()['card']['answer']['artifact']['result']['net_minor']==999999
