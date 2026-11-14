"""Hand-labelled synthetic cases; no actual statements or network."""
from datetime import date
import json
import pytest
from app.statement_wise import WiseRow
from app.transaction_classification import local_classification,cloud_merchant,merchant_key,Classification,BASKETS
from app.statement_classification import suggest,BatchResult
from app.settings import Settings
from app.model_adapter import ModelDecision,ToolCall,ModelError

def row(merchant,ref='CARD-1',amount=-100,**kwargs):
    return WiseRow(ref,date(2026,10,3),amount,'EUR',merchant,**kwargs)

CASES=[
 (row('BOLT *RIDE'),'expense','taxi'),
 (row('BOLT *FOOD'),'expense','dining'),
 (row('BOLT'),'expense',None),
 (row('Unknown synthetic merchant'),'expense',None),
 (row('STARBUCKS OY'),'expense','coffee'),
 (row('Starbucks Ltd'),'expense','coffee'),
 (row('BOLT *RIDE',ref='TRANSFER-1'),'unknown',None),
 (row('BOLT *RIDE',ref='TRANSFER-2',amount=100),'unknown',None),
 (row('BOLT *RIDE',ref='CARD_REFUND-3',amount=100),'refund','taxi'),
 (row('BOLT *RIDE',economic_flow='income',amount=100),'income',None),
 (row('BOLT *RIDE',mcc='5812'),'expense',None),
 (row('Public business',mcc='4121'),'expense','taxi'),
]

@pytest.mark.parametrize('sample,flow,category',CASES)
def test_flow_before_category_and_conflicts(sample,flow,category):
    result=local_classification(sample)
    assert (result.economic_flow,result.category)==(flow,None if cloud_merchant(sample.description) else category)

def test_rules_are_exact_flow_specific_and_do_not_turn_a_transfer_into_a_purchase():
    rules={(merchant_key('Unknown synthetic merchant'),'expense'):'coffee'}
    assert local_classification(row('Unknown synthetic merchant'),rules).basis=='user_rule'
    assert local_classification(row('Unknown synthetic merchant',ref='TRANSFER-2'),rules).economic_flow=='unknown'
    assert local_classification(row('BOLT *RIDE'),{(merchant_key('BOLT *RIDE'),'expense'):'dining'}).category is None

@pytest.mark.parametrize('name',['John Smith','JOHN SMITH OY','joe@example.test','BOLT','BOLT OÜ','STARBUCKS IBAN EE123456789012345678','STARBUCKS invoice 123','Transfer to STARBUCKS OY','Unknown Business Ltd','STARBUCKS OY / personal memo'])
def test_uncertain_deidentification_stays_local(name):
    assert cloud_merchant(name) is None

def test_known_public_brand_aliases_are_deduplicated_without_personal_suffixes():
    assert cloud_merchant('Starbucks OY')==cloud_merchant('STARBUCKS LTD')=='STARBUCKS'

@pytest.mark.anyio
async def test_cloud_does_not_arbitrate_conflicting_source_or_private_rules():
    class Never:
        async def decide(self,*args):raise AssertionError('Conflicting evidence must remain in manual review')
    conflict=row('STARBUCKS OY',mcc='4121',source_category='dining')
    assert local_classification(conflict).needs_review
    assert not local_classification(conflict).cloud_eligible
    assert not local_classification(row('STARBUCKS OY',mcc='4121'),{(merchant_key('STARBUCKS OY'),'expense'):'coffee'}).cloud_eligible
    result,diagnostic=await suggest(Never(),Settings(),[('synthetic',payload([conflict]))])
    assert result=={'synthetic':[]} and diagnostic['model_calls']==0

def payload(samples):
    return {'rows':[{'description':r.description} for r in samples],
        'classifications':[local_classification(r).model_dump() for r in samples]}

@pytest.mark.anyio
async def test_hand_labelled_metrics_and_clean_deduplicated_model_payload():
    captured=[]
    class Fake:
        async def decide(self,request,tools,budget):
            body=json.loads(request.question);captured.append(body)
            assert list(body)==['batch_ref','merchants']
            assert body['merchants']==[{'ref':'m0','merchant':'STARBUCKS'}]
            return ModelDecision((ToolCall('classify_merchants',BatchResult(batch_ref=body['batch_ref'],items=[{'ref':'m0','category':'coffee'}])),),100,30,0)
    samples=[r for r,_,_ in CASES];results,diagnostic=await suggest(Fake(),Settings(),[('synthetic-preview',payload(samples))])
    assert len(captured)==1 and diagnostic['model_calls']==1
    assert results['synthetic-preview']==[{'index':4,'category':'coffee'},{'index':5,'category':'coffee'}]
    local=[local_classification(r) for r in samples]
    assert sum(not c.needs_review for c in local)==5
    assert sum(c.needs_review for c in local)==7
    assert all(c.needs_review or c.category==expected for c,(_,_,expected) in zip(local,CASES))
    # Two correctly suggested coffee rows increase completed classification 5/12 -> 7/12.
    assert len(results['synthetic-preview'])==2
    combined=list(local)
    for item in results['synthetic-preview']:
        original=combined[item['index']]
        combined[item['index']]=Classification(economic_flow=original.economic_flow,category=item['category'],basket=BASKETS[item['category']],basis='gemini')
    assert sum(not c.needs_review for c in combined)==7
    assert sum(c.needs_review for c in combined)==5
    assert sum(not c.needs_review and (c.economic_flow,c.category)!=(flow,category)
        for c,(_,flow,category) in zip(combined,CASES))==0

@pytest.mark.anyio
@pytest.mark.parametrize('fault',['batch','duplicate','category','timeout'])
async def test_invalid_or_late_batch_does_not_modify_local_rows(fault):
    class Fake:
        async def decide(self,request,tools,budget):
            body=json.loads(request.question)
            if fault=='timeout':raise ModelError('MODEL_TIMEOUT')
            if fault=='category':raise ModelError('MODEL_INVALID_RESPONSE')
            result=BatchResult(batch_ref='0'*32 if fault=='batch' else body['batch_ref'],items=[{'ref':'m0','category':'coffee'}]* (2 if fault=='duplicate' else 1))
            return ModelDecision((ToolCall('classify_merchants',result),),100,20,0)
    document=payload([row('STARBUCKS OY')]);before=json.dumps(document)
    result,diagnostic=await suggest(Fake(),Settings(),[('synthetic',document)])
    assert result=={'synthetic':[]} and diagnostic['diagnostic'].startswith('MODEL_')
    assert json.dumps(document)==before
