"""Opt-in isolated PostgreSQL matrix; synthetic bank and Wise bytes, no models."""
import csv
from io import StringIO
import json
from uuid import UUID,uuid4

import psycopg
import pytest

from identity_support import authenticated_app
from test_bank_publication import connect,synchronize
from test_bank_routes import NOW,headers
from test_coach_query import ask
from test_ledger import put

QUESTIONS={
    "en":dict(spend="How much did I spend on taxis last month?",search='Show transactions at "Unknown fixture" last month',
        compare="Compare spending on taxis last month with the previous month",follow="And September?",
        reduce="What if I cut dining out by 20% last month?",safe="How much can I safely spend this week?",
        save="How much can I safely save this month?",empty='Show spending category "absent" last month'),
    "fi":dict(spend="Paljonko kulutin takseihin viime kuussa?",search='Näytä tapahtumat paikassa "Unknown fixture" viime kuussa',
        compare="Vertaa kulutustani takseihin viime kuussa edelliseen kuukauteen",follow="Entä syyskuussa?",
        reduce="Mitä jos vähennän ravintolakuluja 20% viime kuussa?",safe="Paljonko voin turvallisesti käyttää tällä viikolla?",
        save="Paljonko voin turvallisesti säästää tässä kuussa?",empty='Näytä kulut kategoriassa "absent" viime kuussa'),
    "et":dict(spend="Kui palju kulutasin taksodele eelmisel kuul?",search='Näita tehinguid kaupmehelt "Unknown fixture" eelmisel kuul',
        compare="Võrdle kulutusi taksodele eelmisel kuul eelmise kuuga",follow="Aga septembris?",
        reduce="Mis siis, kui vähendan restoranikulusid 20% võrra eelmisel kuul?",safe="Kui palju saan turvaliselt kulutada sel nädalal?",
        save="Kui palju saan turvaliselt säästa sel kuul?",empty='Näita kulusid kategoorias "absent" eelmisel kuul'),
}


def checked(client,auth,question,locale,**fields):
    response=ask(client,auth,question,card_locale=locale,**fields)
    assert response.status_code==200,response.text
    assert response.headers["X-Money-Coach-Source"]=="rule"
    assert "X-Money-Coach-Provider" not in response.headers
    assert response.headers["Server-Timing"].startswith("model;dur=0.0")
    return response.json()


@pytest.mark.parametrize("locale",QUESTIONS)
def test_owned_local_question_matrix_does_not_invent_allowances_or_count_unknown_flows(database,owners,monkeypatch,locale):
    with psycopg.connect(database["admin"]) as connection:
        put(connection,owners[0],amount=-1234,category="taxi")
        put(connection,owners[0],amount=234,flow="refund",category="taxi")
        put(connection,owners[0],amount=-500,category="taxi",day="2026-09-15")
        put(connection,owners[0],amount=-25000,category="dining")
        unknown=put(connection,owners[0],amount=-800,flow="unknown",category="unclassified",merchant="Unknown fixture")
        foreign=put(connection,owners[1],amount=-999999,category="taxi")
    with authenticated_app(database,owners) as (client,app,_):
        app.state.coach_clock=lambda:NOW;auth=headers(client);questions=QUESTIONS[locale]
        async def forbidden(*args,**kwargs): raise AssertionError("No hosted model in local matrix")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        spent=checked(client,auth,questions["spend"],locale)
        assert spent["card"]["answer"]["artifact"]["result"]["net_minor"]==1000
        assert "2026-10-01" in spent["answer_text"] and "2026-10-31" in spent["answer_text"]
        searched=checked(client,auth,questions["search"],locale)
        assert [row["id"] for row in searched["transactions"]["rows"]]==[unknown]
        assert searched["transactions"]["rows"][0]["economic_flow"]=="unknown"
        comparison=checked(client,auth,questions["compare"],locale)
        assert comparison["card"]["answer"]["artifact"]["result"]["change"]["net_minor"]==500
        context=json.dumps(dict(start="2026-10-01",end_exclusive="2026-11-01",tool="spending_totals",category="taxi"))
        follow=checked(client,auth,questions["follow"],locale,conversation_context=context)
        assert follow["card"]["answer"]["artifact"]["result"]["net_minor"]==500
        scenario=checked(client,auth,questions["reduce"],locale)
        assert scenario["card"]["answer"]["status"]=="blocked"  # Direct rows have no verified coverage.
        assert scenario["card"]["answer"]["artifact"]["result"]["result"]["amount_minor"] is None
        for key in ("safe","save"):
            review=checked(client,auth,questions[key],locale)
            assert review["interpretation"]["reason"]=="PLANNING_REVIEW_REQUIRED" and review["card"] is None
        empty=checked(client,auth,questions["empty"],locale)
        assert empty["card"]["answer"]["status"]=="limited" and "0,00 EUR" not in empty["answer_text"] and "0.00 EUR" not in empty["answer_text"]
        assert foreign not in json.dumps(spent)
        assert ask(client,auth,questions["spend"],account_ids=[str(owners[1][2])]).status_code==404
        other=headers(client,"mika")
        other_spend=checked(client,other,questions["spend"],locale)
        assert other_spend["card"]["answer"]["artifact"]["result"]["net_minor"]==999999


@pytest.mark.parametrize("locale",QUESTIONS)
def test_same_content_bank_and_statement_sources_match_after_review_then_extra_account_adds_exact_delta(database,owners,monkeypatch,locale):
    with authenticated_app(database,owners,statement_imports_enabled=True) as (client,app,config):
        auth,bank,user=connect(client,app,"s-bank-demo","coach-equivalence")
        synchronize(database,client,app,config,auth,bank,user)
        app.state.coach_clock=lambda:NOW
        async def forbidden(*args,**kwargs): raise AssertionError("Source equivalence is fully local")
        monkeypatch.setattr(app.state.model,"decide",forbidden)
        ids=[row["id"] for row in client.get("/v1/accounts/sources").json() if row["source"]]
        assert len(ids)==1
        source=UUID(ids[0])
        with psycopg.connect(database["admin"]) as connection:
            rows=connection.execute("""SELECT booked_on,amount_minor,merchant,category,basket,economic_flow
                FROM moneylens.transactions WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s
                AND status='booked' AND booked_on>='2026-10-01' AND booked_on<'2026-11-01' ORDER BY booked_on,id""",(*owners[0][:2],source)).fetchall()
        assert rows
        content=StringIO();writer=csv.writer(content)
        writer.writerow(["TransferWise ID","Date","Amount","Currency","Description"])
        for index,(day,minor,merchant,*_) in enumerate(rows):
            whole,fraction=divmod(abs(minor),100)
            writer.writerow([f"synthetic-{index}",day.strftime("%d-%m-%Y"),f"{'-' if minor<0 else ''}{whole}.{fraction:02d}","EUR",merchant])
        preview=client.post("/v1/statements/wise/preview",headers=auth,json={"csv":content.getvalue()})
        assert preview.status_code==200,preview.text
        confirmed=client.post("/v1/statements/wise/confirm",headers=auth,json={"preview_id":preview.json()["id"]})
        assert confirmed.status_code==200,confirmed.text
        imported=confirmed.json()["account_id"]
        def spending(accounts):
            body=checked(client,auth,QUESTIONS[locale]["spend"],locale,account_ids=accounts)
            return body["card"]["answer"]["artifact"]["result"]
        raw=checked(client,auth,"Show spending last month",locale,account_ids=[imported])["card"]["answer"]["artifact"]["result"]
        assert raw["net_minor"]==raw["expense_count"]==0 and raw["unresolved_flow_count"]>0
        # Explicit trusted synthetic review, independent of Coach. Unknown import
        # rows become expenses/refunds/transfers only after this fixture decision.
        with psycopg.connect(database["admin"]) as connection:
            for day,minor,merchant,category,basket,flow in rows:
                connection.execute("""UPDATE moneylens.transactions SET category=%s,basket=%s,economic_flow=%s
                    WHERE tenant_id=%s AND owner_user_id=%s AND account_id=%s AND booked_on=%s AND amount_minor=%s AND merchant=%s""",
                    (category,basket,flow,*owners[0][:2],UUID(imported),day,minor,merchant))
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        first,second=spending([str(source)]),spending([imported])
        for key in ("gross_minor","refunds_minor","net_minor","expense_count","refund_count","category_baskets","merchants"):
            assert first[key]==second[key]
        assert first["net_minor"]>0 and first["scope"]["account_ids"]!=second["scope"]["account_ids"]
        assert first["scope"]["dataset_coverage"]!=second["scope"]["dataset_coverage"]  # Amount equivalence does not invent coverage.
        scenario=checked(client,auth,QUESTIONS[locale]["reduce"],locale,account_ids=[str(source)])
        evidence=scenario["card"]["answer"]["artifact"]["result"]
        assert evidence["result"]["amount_minor"]==(evidence["baseline"]["net_minor"]*2000+5000)//10000
        assert evidence["result_kind"]=="hypothetical_cost_reduction"
        extra=uuid4()
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("INSERT INTO moneylens.accounts (tenant_id,owner_user_id,id,name,currency,account_type) VALUES (%s,%s,%s,'Synthetic extra','EUR','current')",(*owners[0][:2],extra))
            put(connection,(*owners[0][:2],extra),amount=-777,category="taxi")
            put(connection,(*owners[0][:2],extra),amount=77,flow="refund",category="taxi")
            put(connection,(*owners[0][:2],extra),amount=-900000,flow="unknown",category="unclassified")
            connection.execute("UPDATE moneylens.user_state SET data_version=data_version+1 WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2])
        assert spending([imported,str(extra)])["net_minor"]-second["net_minor"]==700
        assert spending([imported])["net_minor"]==second["net_minor"]
