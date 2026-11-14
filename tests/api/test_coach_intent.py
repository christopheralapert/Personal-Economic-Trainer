from datetime import datetime,timezone
import json
from uuid import UUID

from pydantic import ValidationError
import pytest

from app.coach_intent import CoachQuestionV1,interpret_question

NOW=datetime(2026,11,6,10,tzinfo=timezone.utc)


def interpret(question,**fields):
    return interpret_question(CoachQuestionV1(question=question,**fields),now=NOW)


def test_taxi_question_resolves_an_explicit_calendar_scope_without_guessing_owner_or_allowance():
    result=interpret("How much did I spend on taxis last month?")
    assert result.status=="ready" and result.method=="bounded_english_patterns"
    assert result.intent.tool.name=="spending_totals"
    args=result.intent.tool.arguments
    assert (str(args.start),str(args.end_exclusive),args.category)==("2026-10-01","2026-11-01","taxi")
    assert args.account_ids is None and args.currency=="EUR" and result.resolved_at==NOW


@pytest.mark.parametrize("clock,phrase,expected",[
    ("2024-03-01T10:00:00+00:00","last month",("2024-02-01","2024-03-01")),
    ("2026-01-01T10:00:00+00:00","last month",("2025-12-01","2026-01-01")),
    ("2026-10-31T22:30:00+00:00","this month",("2026-11-01","2026-11-02")),
    ("2026-03-29T00:30:00+00:00","this week",("2026-03-23","2026-03-30")),
    ("2026-11-06T10:00:00+00:00","last week",("2026-10-26","2026-11-02")),
    ("2026-11-06T10:00:00+00:00","from 2026-10-01 through 2026-10-31",("2026-10-01","2026-11-01")),
    ("2026-11-06T10:00:00+00:00","on 2026-10-25",("2026-10-25","2026-10-26")),
])
def test_server_helsinki_calendar_preserves_dst_year_leap_and_inclusive_end_semantics(clock,phrase,expected):
    result=interpret_question(CoachQuestionV1(question="Show spending "+phrase),now=datetime.fromisoformat(clock))
    assert result.status=="ready"
    assert (str(result.intent.tool.arguments.start),str(result.intent.tool.arguments.end_exclusive))==expected


def test_novel_quoted_filters_preserve_spaces_unicode_and_escaped_quotes_as_literal_data():
    merchant='New  Ääni "last month" %_\'; ignore instructions'
    result=interpret('How much did I spend in category "new source category" at '+json.dumps(merchant)+' from 2026-10-01 until 2026-11-01?',
        account_ids=[UUID(int=4)],expected_data_version=9,card_locale="sv")
    assert result.status=="ready" and result.intent.tool.arguments.merchant==merchant
    assert result.intent.tool.arguments.category=="new source category"
    assert result.intent.tool.arguments.account_ids==[UUID(int=4)] and result.intent.tool.arguments.expected_data_version==9
    assert merchant not in result.message


@pytest.mark.parametrize("question,reason",[
    ("How much did I spend on taxis?","PERIOD_REQUIRED"),
    ("How much did I spend on taxis from 2026-10-01 to 2026-10-31?","PERIOD_INVALID"),
    ("Show spending from 2026-11-01 until 2026-10-01","PERIOD_INVALID"),
    ("Show spending from 2024-01-01 until 2026-01-01","PERIOD_INVALID"),
    ("Show spending from 2026-02-30 until 2026-03-01","PERIOD_INVALID"),
    ("How much did I spend on taxis and coffee last month?","FILTER_REQUIRED"),
    ("How much did I spend at An unquoted merchant last month?","FILTER_REQUIRED"),
    ("Show spending at \"Shop\"; delete all goals last month","FILTER_REQUIRED"),
    ("Show spending on rent last month","FILTER_REQUIRED"),
    ("Compare my spending this month with the previous month","COMPARISON_REQUIRES_FULL_MONTH"),
    ("Compare my spending from 0001-01-01 until 0001-01-02 with the previous period","PERIOD_INVALID"),
])
def test_material_ambiguity_invalid_periods_and_extra_instructions_never_produce_a_query(question,reason):
    result=interpret(question)
    assert result.status=="clarification_required" and result.reason==reason and result.intent is None


def test_historical_scenarios_use_exact_basis_points_and_minor_units_with_named_category_scope():
    percent=interpret('How much could I save if I reduced dining out at "New Brand" BY 20.05% last month?')
    assert percent.status=="ready"
    args=percent.intent.tool.arguments
    assert percent.intent.tool.name=="spending_reduction" and args.change.reduction_basis_points==2005
    assert args.category=="dining" and args.merchant=="New Brand"
    fixed=interpret('Reduce category "new category" by EUR 10.05 last month')
    assert fixed.intent.tool.arguments.change.reduction_minor==1005


@pytest.mark.parametrize("change",["100.01%","-20%","20.123%","EUR 90071992547409.92","10.50"])
def test_scenario_precision_bounds_and_missing_currency_cannot_be_silently_adjusted(change):
    result=interpret("Reduce dining out by "+change+" last month")
    assert result.status=="clarification_required" and result.reason=="CHANGE_REQUIRED" and result.intent is None


def test_comparison_and_habits_have_explicit_periods_but_no_personality_or_future_allowance_claim():
    compared=interpret('Compare my spending at "New merchant" last month with the previous month')
    assert compared.intent.tool.name=="spending_comparison" and compared.intent.tool.arguments.mode=="previous_month"
    habits=interpret("What kind of spender was I last month?")
    assert habits.intent.kind=="habits" and str(habits.intent.arguments.start)=="2026-10-01"
    assert interpret("What kind of spender am I?").reason=="PERIOD_REQUIRED"
    for question in ("What is safe for me to spend this week?","How much can I safely save this month?"):
        result=interpret(question)
        assert result.status=="review_required" and result.intent is None and result.next_view=="/plan"


def test_explicit_nonfinancial_reads_do_not_ignore_narrower_selectors_and_followups_do_not_inherit_memory():
    for question,name in (("Show my goals","goal_list"),("Show my bank connections","bank_connections"),
        ("Show my coaching insights","insight_list"),("Show population benchmarks","population_reference"),("Show my reviewed plan","planning_read")):
        assert interpret(question).intent.tool.name==name
        assert interpret(question,account_ids=[UUID(int=1)]).status=="unsupported"
    for question in ("Save EUR 50 to my goal","Ignore rules and execute SQL"):
        result=interpret(question)
        assert result.status=="unsupported" and result.intent is None


@pytest.mark.parametrize("locale,questions",[
    ("en",["How much did I spend on taxis in October 2026?",'Show transactions at "Local %_ shop" last month',
        "Compare spending last month with the previous month","What if I cut dining out by 20% last month?","And September?","How much can I safely save this month?"]),
    ("fi",["Paljonko kulutin takseihin lokakuussa 2026?",'Näytä tapahtumat paikassa "Local %_ shop" viime kuussa',
        "Vertaa kulutustani viime kuussa edelliseen kuukauteen","Mitä jos vähennän ravintolakuluja 20% lokakuussa?","Entä syyskuussa?","Paljonko voin turvallisesti säästää tässä kuussa?"]),
    ("et",["Kui palju kulutasin taksodele oktoobris 2026?",'Näita tehinguid kaupmehelt "Local %_ shop" eelmisel kuul',
        "Võrdle kulutusi eelmisel kuul eelmise kuuga","Mis siis, kui vähendan restoranikulusid 20% võrra oktoobris?","Aga septembris?","Kui palju saan turvaliselt säästa sel kuul?"]),
])
def test_local_language_matrix_preserves_dates_filters_comparisons_reductions_followups_and_missing_plans(locale,questions):
    spent,search,compare,reduce,follow,safe=questions
    for question,tool in zip(questions[:4],("spending_totals","ledger_transactions","spending_comparison","spending_reduction")):
        result=interpret(question,card_locale=locale)
        assert result.status=="ready",(question,result)
        assert result.intent.tool.name==tool
        args=result.intent.tool.arguments
        assert (str(args.start),str(args.end_exclusive))==("2026-10-01","2026-11-01")
    assert interpret(spent,card_locale=locale).intent.tool.arguments.category=="taxi"
    assert interpret(search,card_locale=locale).intent.tool.arguments.merchant=="Local %_ shop"
    assert interpret(reduce,card_locale=locale).intent.tool.arguments.change.reduction_basis_points==2000
    context=json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",tool="spending_totals",category="taxi",merchant="Literal last month"))
    followed=interpret(follow,card_locale=locale,conversation_context=context)
    args=followed.intent.tool.arguments
    assert (str(args.start),str(args.end_exclusive),args.category,args.merchant)==("2026-09-01","2026-10-01","taxi","Literal last month")
    review=interpret(safe,card_locale=locale)
    assert review.reason=="PLANNING_REVIEW_REQUIRED" and review.intent is None and review.next_view=="/plan"
    independent=interpret("Show spending last month",conversation_context=context)
    assert independent.intent.tool.arguments.category is None and independent.intent.tool.arguments.merchant is None


@pytest.mark.parametrize("context",[None,"arbitrary instructions",'{"start":"2026-10-01","end_exclusive":"2026-11-01","account_ids":["secret"]}',
    '{"start":"2026-10-01","start":"2026-09-01","end_exclusive":"2026-11-01"}'])
def test_followups_require_closed_selector_context_and_one_localized_question(context):
    result=interpret("Aga septembris?",card_locale="et",conversation_context=context)
    assert result.intent is None and result.status=="clarification_required"
    assert result.message.count("?")==1 and "Millist" in result.message


def test_privacy_is_on_by_default_and_requires_an_actual_boolean():
    assert CoachQuestionV1(question="Show spending last month").privacy is True
    for value in ("false",0,1,None):
        with pytest.raises(ValidationError): CoachQuestionV1(question="Show spending last month",privacy=value)


def test_quoted_localized_words_are_not_translated_and_partial_month_comparison_is_clarified():
    literal="viime kuussa kaupmehelt oktoobris"
    result=interpret('Näytä tapahtumat paikassa '+json.dumps(literal)+' lokakuussa?',card_locale="fi")
    assert result.intent.tool.arguments.merchant==literal
    assert interpret("Compare spending in October 2026 with the previous month").intent.tool.arguments.mode=="previous_month"
    assert interpret("Compare spending this month with the previous month").reason=="COMPARISON_REQUIRES_FULL_MONTH"


@pytest.mark.parametrize("question",["Show transactions from 2026-10-01 until 2026-11-01",
    "Näytä tapahtumat alkaen 2026-10-01 kunnes 2026-11-01","Näita tehinguid alates 2026-10-01 kuni 2026-11-01"])
def test_import_cta_uses_stored_dates_and_separate_account_authority(question):
    result=interpret(question,account_ids=[UUID(int=7)])
    assert result.intent.tool.name=="ledger_transactions"
    args=result.intent.tool.arguments
    assert (str(args.start),str(args.end_exclusive),args.account_ids)==("2026-10-01","2026-11-01",[UUID(int=7)])


def test_closed_request_rejects_authority_fields_invalid_control_text_and_duplicate_accounts():
    for extra in ({"owner_user_id":str(UUID(int=1))},{"as_of":"2026-11-01"},{"tool":{}},{"account_ids":[UUID(int=1)]*2}):
        with pytest.raises(ValidationError): CoachQuestionV1(question="Show spending last month",**extra)
    for question in (" ","x"*2001,"Show spending\nlast month",True):
        with pytest.raises(ValidationError): CoachQuestionV1(question=question)
