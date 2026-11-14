"""Native Gemini wire contract; injected transports only, no credentials/network."""
import asyncio
from datetime import date
import errno
import json

import httpx
import pytest

from app.contracts import Contract
from app.gemini_adapter import GEMINI_ENDPOINT,GeminiFunctions
from app.model_adapter import ModelError,ModelInput,ToolDefinition,TurnBudget,build_model
from app.settings import Settings


class Scope(Contract):
    start: date
    end_exclusive: date
    category: str | None


ARGS=dict(start="2026-10-01",end_exclusive="2026-11-01",category="taxi")
TOOLS=(ToolDefinition("interpret","Choose validated financial selectors, never calculate.",Scope),)
INPUT=ModelInput("Only interpret the question; server tools compute.","Kui palju kulutasin taksodele oktoobris 2026?")


def config(**changes):
    values=dict(environment="test",model_enabled=True,model_billing_policy="paid_allowed",model_provider="gemini",
        model_name="gemini-3.5-flash",gemini_api_key="test-only",model_input_microusd_per_token=1,model_output_microusd_per_token=5)
    return Settings(**{**values,**changes})


def document():
    return dict(candidates=[dict(finishReason="STOP",content=dict(parts=[dict(functionCall=dict(name="interpret",args=ARGS))]))],
        usageMetadata=dict(promptTokenCount=120,candidatesTokenCount=40,totalTokenCount=160))


async def invoke(body=None,*,status=200,settings=None,request=INPUT,transport=None):
    sent=[]
    def respond(wire):
        sent.append(wire)
        return httpx.Response(status,json=document() if body is None else body)
    model=build_model(settings or config(),transport=transport or httpx.MockTransport(respond));budget=TurnBudget(model.settings)
    try:return await model.decide(request,TOOLS,budget),sent,budget
    finally:await model.close()


def test_native_request_and_provider_selection_keep_authority_on_server():
    result,sent,budget=asyncio.run(invoke())
    wire=sent[0];payload=json.loads(wire.content)
    assert str(wire.url)==GEMINI_ENDPOINT
    assert wire.headers['x-goog-api-key']=='test-only'
    assert 'authorization' not in wire.headers
    assert payload['contents']==[dict(role='user',parts=[dict(text=INPUT.question)])]
    assert payload['toolConfig']['functionCallingConfig']['mode']=='ANY'
    assert payload['generationConfig']['thinkingConfig']==dict(thinkingLevel='MINIMAL')
    schema=payload['tools'][0]['functionDeclarations'][0]['parametersJsonSchema']
    assert schema['additionalProperties'] is False and set(schema['required'])==set(ARGS)
    for forbidden in ('owner_user_id','account_id','transactions','ledger_rows','IBAN','test-only'):
        assert forbidden not in wire.content.decode()
    assert result.calls[0].arguments.start==date(2026,10,1)
    assert result.calls[0].arguments.category=='taxi'
    assert (budget.calls,budget.tools,budget.cost)==(1,1,320)
    assert result.input_tokens==120 and result.output_tokens==40


@pytest.mark.parametrize('settings,code',[
    (dict(model_enabled=False),'MODEL_NOT_CONFIGURED'),(dict(gemini_api_key=None),'MODEL_NOT_CONFIGURED'),
    (dict(model_billing_policy='free_only'),'MODEL_FREE_ONLY_UNAVAILABLE')])
def test_no_network_when_not_explicitly_admitted(settings,code):
    def forbidden(request):raise AssertionError('Network must not run')
    with pytest.raises(ModelError,match='^'+code+'$'):
        asyncio.run(invoke(settings=config(**settings),transport=httpx.MockTransport(forbidden)))


@pytest.mark.parametrize('status,code',[(401,'MODEL_ACCESS_DENIED'),(403,'MODEL_ACCESS_DENIED'),(429,'MODEL_THROTTLED'),(500,'MODEL_UNAVAILABLE'),(307,'MODEL_UNAVAILABLE')])
def test_stable_provider_failure_without_raw_body_or_retry(status,code):
    with pytest.raises(ModelError,match='^'+code+'$') as caught:
        asyncio.run(invoke(dict(error='private-provider-body'),status=status))
    assert 'private-provider-body' not in str(caught.value)


@pytest.mark.parametrize('change,code',[
    ('unfinished','MODEL_INCOMPLETE'),('missing','MODEL_INVALID_TOOL_COUNT'),('parallel','MODEL_INVALID_TOOL_COUNT'),
    ('authority','MODEL_INVALID_ARGUMENTS'),('wrong-type','MODEL_INVALID_RESPONSE'),('unknown','MODEL_INVALID_TOOL'),
    ('text','MODEL_UNSUPPORTED_OUTPUT'),('usage','MODEL_USAGE_INVALID'),('bool-usage','MODEL_USAGE_INVALID')])
def test_model_output_cannot_add_authority_or_unverified_answer(change,code):
    body=document();candidate=body['candidates'][0];part=candidate['content']['parts'][0]
    if change=='unfinished':candidate['finishReason']='MAX_TOKENS'
    elif change=='missing':candidate['content']['parts']=[]
    elif change=='parallel':candidate['content']['parts']*=2
    elif change=='authority':part['functionCall']['args']={**ARGS,'account_id':'not-authority'}
    elif change=='wrong-type':part['functionCall']['args']={**ARGS,'start':123}
    elif change=='unknown':part['functionCall']['name']='execute_sql'
    elif change=='text':candidate['content']['parts'].append(dict(text='You can safely spend 99999 EUR'))
    elif change=='usage':body['usageMetadata']['totalTokenCount']=999999
    elif change=='bool-usage':body['usageMetadata']['promptTokenCount']=True
    with pytest.raises(ModelError,match='^'+code+'$'):asyncio.run(invoke(body))


def test_network_permission_failure_is_identified_without_logging_secrets():
    def denied(request):
        try:raise PermissionError(errno.EACCES,'blocked')
        except PermissionError as cause:raise httpx.ConnectError('unsafe-secret',request=request) from cause
    with pytest.raises(ModelError,match='^MODEL_NETWORK_ACCESS_DENIED$'):
        asyncio.run(invoke(transport=httpx.MockTransport(denied)))


def test_other_gemini_models_are_not_silently_selected():
    with pytest.raises(ValueError,match='reviewed gemini-3.5-flash'):
        config(model_name='gemini-other')


def test_existing_root_key_alias_and_blank_example_are_safe(monkeypatch):
    monkeypatch.delenv('MONEYLENS_GEMINI_API_KEY',raising=False)
    monkeypatch.setenv('GEMINI_API_KEY','')
    assert Settings().gemini_api_key is None
    monkeypatch.setenv('GEMINI_API_KEY','local-test-key-not-real')
    settings=Settings()
    assert settings.gemini_api_key.get_secret_value()=='local-test-key-not-real'
    assert 'local-test-key-not-real' not in repr(settings)
