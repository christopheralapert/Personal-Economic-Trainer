from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from uuid import UUID,uuid4

import psycopg
import pytest

from app.coaching import SetCoachingPreferencesV1
from app.coaching_store import CoachingStore
from app.identity import AuthError
from app.jobs import JobStore
from identity_support import ORIGIN,authenticated_app
from test_bank_routes import headers

NOW=datetime(2026,11,5,10,tzinfo=timezone.utc)
PATH="/v1/coaching/preferences"
BODY=dict(key="preferences-1",expected_preferences_version=1,coaching_enabled=True,bill_insights=True,
    headroom_insights=True,spending_insights=True,timezone="Europe/Helsinki",quiet_start="22:00",quiet_end="07:00")


def facts(database,owner):
    with psycopg.connect(database["admin"]) as connection:
        return connection.execute("""SELECT data_version,plan_version,goal_version,
            (SELECT count(*) FROM moneylens.coaching_preferences WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.coaching_commands WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.audit_events WHERE tenant_id=%s AND owner_user_id=%s),
            (SELECT count(*) FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s)
            FROM moneylens.user_state WHERE tenant_id=%s AND owner_user_id=%s""",owner[:2]*5).fetchone()


def test_default_is_unpersisted_opt_out_and_explicit_updates_replay_without_financial_changes(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coaching_clock=lambda:NOW;auth=headers(client)
        initial=client.get(PATH);assert initial.status_code==200
        assert "no-store" in initial.headers["cache-control"]
        assert initial.json()["version"]==1 and initial.json()["coaching_enabled"] is False
        assert initial.json()["state"]["generation_active"] is False and initial.json()["created_at"] is None
        assert initial.json()["state"]["external_delivery_available"] is False
        assert facts(database,owners[0])==(1,1,1,0,0,0,0)
        response=client.post(PATH,headers=auth,json=BODY);assert response.status_code==200,response.text
        first=response.json();assert first["preferences"]["version"]==2 and first["historical_command_snapshot"] is True
        assert "state" not in first["preferences"]
        assert client.post(PATH,headers=auth,json=BODY).json()==first
        assert client.get(PATH).json()["state"]["generation_active"] is True
        optout={**BODY,"key":"opt-out","expected_preferences_version":2,"coaching_enabled":False}
        assert client.post(PATH,headers=auth,json=optout).json()["preferences"]["version"]==3
        assert client.post(PATH,headers=auth,json=BODY).json()==first
        current=client.get(PATH).json();assert current["coaching_enabled"] is False and current["version"]==3
        assert facts(database,owners[0])==(1,1,1,1,2,2,2)
        other=headers(client,"mika");assert client.get(PATH).json()["coaching_enabled"] is False
        assert client.get(PATH).json()["id"]!=first["preferences"]["id"]
        assert client.post(PATH,headers=auth,json=BODY).status_code==409
        assert client.post(PATH,headers=other,json=BODY).status_code==200
        with psycopg.connect(database["admin"]) as connection:
            payload=connection.execute("SELECT payload FROM moneylens.outbox_events WHERE tenant_id=%s AND owner_user_id=%s ORDER BY created_at,id LIMIT 1",owners[0][:2]).fetchone()[0]
            assert set(payload)=={"preferences_id","preferences_version"}


def test_pause_expires_at_server_time_and_old_command_replay_remains_historical(database,owners):
    body={**BODY,"paused_until":(NOW+timedelta(hours=1)).isoformat()}
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coaching_clock=lambda:NOW;auth=headers(client)
        first=client.post(PATH,headers=auth,json=body);assert first.status_code==200
        assert client.get(PATH).json()["state"]["paused"] is True
        app.state.coaching_clock=lambda:NOW+timedelta(hours=1)
        current=client.get(PATH).json();assert current["state"]["paused"] is False and current["state"]["generation_active"] is True
        assert client.post(PATH,headers=auth,json=body).json()==first.json()
        assert facts(database,owners[0])==(1,1,1,1,1,1,1)


@pytest.mark.parametrize("delta",[timedelta(),timedelta(seconds=-1),timedelta(days=366)])
def test_new_pause_must_be_future_and_at_most_one_year_without_effects(database,owners,delta):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coaching_clock=lambda:NOW;auth=headers(client)
        response=client.post(PATH,headers=auth,json={**BODY,"paused_until":(NOW+delta).isoformat()})
        assert response.status_code==422 and response.json()["error"]["code"]=="INVALID_COACHING_PAUSE"
        assert facts(database,owners[0])==(1,1,1,0,0,0,0)


def test_exact_concurrent_retries_have_one_effect_and_competing_versions_have_one_winner(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coaching_clock=lambda:NOW;auth=headers(client)
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        def attempt(body):
            try:
                with app.state.pools.finance.connection() as connection:
                    return CoachingStore(connection,user,clock=lambda:NOW).set(SetCoachingPreferencesV1(**body))
            except AuthError as error: return error
        with ThreadPoolExecutor(max_workers=2) as workers: first,second=list(workers.map(attempt,[BODY,BODY]))
        assert first==second and facts(database,owners[0])==(1,1,1,1,1,1,1)
        with ThreadPoolExecutor(max_workers=2) as workers:
            results=list(workers.map(attempt,[{**BODY,"key":"change-a","expected_preferences_version":2,"coaching_enabled":False},
                {**BODY,"key":"change-b","expected_preferences_version":2,"spending_insights":False}]))
        assert sum(isinstance(result,AuthError) for result in results)==1
        assert [result.code for result in results if isinstance(result,AuthError)]==["COACHING_VERSION_CHANGED"]
        assert facts(database,owners[0])==(1,1,1,1,2,2,2)


def test_preferences_commands_audit_and_outbox_roll_back_together(database,owners,monkeypatch):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client)
        def fail(*args,**kwargs): raise RuntimeError("owned coaching outbox failure")
        with monkeypatch.context() as patch:
            patch.setattr(JobStore,"emit",fail);response=client.post(PATH,headers=auth,json=BODY)
            assert response.status_code==500 and "owned coaching outbox failure" not in response.text
        assert facts(database,owners[0])==(1,1,1,0,0,0,0)
        assert client.post(PATH,headers=auth,json=BODY).status_code==200


def test_command_conflicts_throttle_and_version_exhaustion_do_not_silently_apply_changes(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        app.state.coaching_clock=lambda:NOW;auth=headers(client)
        first=client.post(PATH,headers=auth,json=BODY).json()
        assert client.post(PATH,headers=auth,json={**BODY,"coaching_enabled":False}).status_code==409
        assert client.post(PATH,headers=auth,json={**BODY,"key":"stale"}).status_code==409
        with psycopg.connect(database["admin"]) as connection:
            for index in range(99):
                connection.execute("""INSERT INTO moneylens.coaching_commands
                    (tenant_id,owner_user_id,id,preferences_id,command_key,request_fingerprint,applied_at,receipt)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,'{}')""",(*owners[0][:2],uuid4(),first["preferences"]["id"],f"quota-{index}","0"*64,NOW))
        changed={**BODY,"key":"later","expected_preferences_version":2,"coaching_enabled":False}
        blocked=client.post(PATH,headers=auth,json=changed)
        assert blocked.status_code==429 and blocked.headers["retry-after"]=="3600"
        assert client.post(PATH,headers=auth,json=BODY).json()==first
        app.state.coaching_clock=lambda:NOW+timedelta(hours=1,seconds=1)
        assert client.post(PATH,headers=auth,json=changed).status_code==200
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.coaching_preferences SET version=%s WHERE tenant_id=%s AND owner_user_id=%s",(2**53-1,*owners[0][:2]))
        exhausted=client.post(PATH,headers=auth,json={**BODY,"key":"exhausted","expected_preferences_version":2**53-1})
        assert exhausted.status_code==409 and exhausted.json()["error"]["code"]=="COACHING_VERSION_EXHAUSTED"


def test_preferences_and_immutable_receipts_force_owner_rls(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        auth=headers(client);first=client.post(PATH,headers=auth,json=BODY).json()
    from app.database import TrustedScope,tenant_transaction
    with psycopg.connect(database["runtime"],autocommit=True) as connection:
        for owner in owners[1:]:
            with tenant_transaction(connection,TrustedScope(*owner[:2])):
                assert connection.execute("SELECT id FROM moneylens.coaching_preferences").fetchall()==[]
                assert connection.execute("SELECT id FROM moneylens.coaching_commands").fetchall()==[]
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
                connection.execute("UPDATE moneylens.coaching_commands SET receipt='{}' WHERE id=%s",(first["id"],))
        with tenant_transaction(connection,TrustedScope(*owners[0][:2])):
            assert connection.execute("SELECT id FROM moneylens.coaching_commands").fetchall()==[(UUID(first["id"]),)]


def test_auth_csrf_expected_session_body_and_authority_boundaries(database,owners):
    with authenticated_app(database,owners) as (client,app,config):
        assert client.get(PATH).status_code==401 and client.post(PATH,json=BODY).status_code==401
        auth=headers(client)
        assert client.post(PATH,headers={"Origin":ORIGIN},json=BODY).status_code==403
        assert client.post(PATH,headers={**auth,"Origin":"https://foreign.invalid"},json=BODY).status_code==403
        assert client.post(PATH,headers={**auth,"X-MoneyLens-Session-ID":str(uuid4())},json=BODY).status_code==409
        assert client.post(PATH,headers=auth,content=b"x"*8193).status_code==413
        for extra in ({"owner_user_id":str(owners[1][1])},{"generation_active":True},{"push_enabled":True},{"version":2},{"coaching_enabled":1}):
            assert client.post(PATH,headers=auth,json={**BODY,**extra}).status_code==422
        user=app.state.identity.resolve(client.cookies.get("moneylens_session"))
        with psycopg.connect(database["admin"]) as connection:
            connection.execute("UPDATE moneylens.users SET active=false,permission_version=permission_version+1 WHERE tenant_id=%s AND id=%s",owners[0][:2])
        with app.state.pools.finance.connection() as connection:
            with pytest.raises(AuthError): CoachingStore(connection,user).set(SetCoachingPreferencesV1(**BODY))
        assert client.get(PATH).status_code==401 and client.post(PATH,headers=auth,json=BODY).status_code==401
