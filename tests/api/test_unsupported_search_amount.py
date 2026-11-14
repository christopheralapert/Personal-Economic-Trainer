"""Never silently discard a requested predicate absent from the search schema."""
import asyncio
from datetime import datetime,timezone
import pytest
from app.coach_intent import CoachQuestionV1,interpret_question,unsupported_amount_filter
from app.coach_model import interpret_with_model
from app.model_adapter import TurnBudget
from app.settings import Settings

QUESTIONS=[('en',"Show last month's taxi transactions over EUR 20."),('fi','Näytä viime kuun yli 20 euron taksimatkat.'),('et','Näita eelmise kuu üle 20 euro taksosõite.'),
    ('et','Näita eelmise kuu üle 20 € taksosõite'),('en',"Show last month's taxi rides over €20"),('fi','Näytä viime kuun yli 20 € taksimatkat')]


@pytest.mark.parametrize('locale,question',QUESTIONS)
def test_amount_predicate_is_an_explicit_local_clarification_before_the_provider(locale,question):
    calls=[]
    class Forbidden:
        async def decide(self,*args):calls.append(True);raise AssertionError('No provider call')
    body=CoachQuestionV1(question=question,card_locale=locale,privacy=False);now=datetime(2026,11,14,tzinfo=timezone.utc)
    local=interpret_question(body,now=now);model=asyncio.run(interpret_with_model(Forbidden(),body,now,TurnBudget(Settings())))
    for answer in (local,model):
        assert answer.reason=='FILTER_REQUIRED' and answer.intent is None and answer.status=='clarification_required'
        assert answer.message.count('?')==1
    assert calls==[]


@pytest.mark.parametrize('question',['Show taxi transactions in October 2026','What if I reduced dining by 20% last month?',
    'Show transactions from 2026-10-01 until 2026-11-01','Show transactions at "Over 20 Cafe" last month'])
def test_supported_dates_reductions_and_literal_merchants_are_not_amount_predicates(question):
    assert not unsupported_amount_filter(question)
