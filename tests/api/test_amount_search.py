import json
from datetime import datetime,timezone
from pathlib import Path
import pytest
from app.amount_search import amount_selection
from app.coach_intent import CoachQuestionV1,interpret_question
from test_coach_model import interpret,BASE
from app.model_adapter import ModelError

FIXTURE=json.loads((Path(__file__).resolve().parents[2]/'fixtures/synthetic/amount-search.v1.json').read_text(encoding='utf-8'))
NOW=datetime(2026,11,14,tzinfo=timezone.utc)

@pytest.mark.parametrize('sample',FIXTURE['supported'])
def test_cross_runtime_exact_cent_vectors(sample):
    selected=amount_selection(sample['question'])
    assert selected.present and selected.valid and selected.bounds==sample['bounds']
    if sample.get('parseOnly'):return
    result=interpret_question(CoachQuestionV1(question=sample['question']),now=NOW)
    assert result.status=='ready' and result.intent.tool.name=='ledger_transactions'
    for key,value in sample['bounds'].items():assert getattr(result.intent.tool.arguments,key)==value

@pytest.mark.parametrize('question',FIXTURE['unsupported'])
def test_unknown_or_ambiguous_predicate_never_becomes_an_unfiltered_query(question):
    selected=amount_selection(question)
    assert selected.present and not selected.valid
    assert interpret_question(CoachQuestionV1(question=question),now=NOW).intent is None

def test_model_selection_cannot_displace_bounds_or_other_explicit_filters():
    question="Show last month's taxi rides over EUR 20."
    result,sent,_,_=interpret(question,values={**BASE,'intent':'transactions'})
    assert len(sent)==1 and result.method=='structured_model'
    assert result.intent.tool.arguments.amount_min_minor==2001
    assert 'amount_min_minor' not in sent[0]['input'][0]['content']
    for changed in ({'intent':'spending'},{'category':'coffee'},{'start':'2026-10-02'}):
        with pytest.raises(ModelError):interpret(question,values={**BASE,'intent':'transactions',**changed})

def test_local_followup_keeps_bounds_literal_merchant_and_current_account_authority():
    context=json.dumps(dict(start='2026-10-01',end_exclusive='2026-11-01',tool='ledger_transactions',category='taxi',merchant='City  Taxi',amount_min_minor=2001,amount_max_minor=3097))
    result=interpret_question(CoachQuestionV1(question='What about the month before?',conversation_context=context),now=NOW)
    args=result.intent.tool.arguments
    assert str(args.start)=='2026-09-01' and args.amount_min_minor==2001 and args.amount_max_minor==3097 and args.merchant=='City  Taxi'
