from contextlib import contextmanager

from fastapi.testclient import TestClient
import psycopg

from app.main import create_app
from app.settings import Settings
from app.identity import DEMO_ISSUER

ORIGIN = "http://127.0.0.1:3000"


@contextmanager
def authenticated_app(database,owners,**overrides):
    with psycopg.connect(database["admin"],autocommit=True) as connection:
        for owner,subject,name in zip(owners[:2],("aino.v1","mika.v1"),("Synthetic Aino","Synthetic Mika")):
            connection.execute("""UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,
                is_synthetic=true,display_name=%s WHERE tenant_id=%s AND id=%s""",(DEMO_ISSUER,subject,name,*owner[:2]))
    config = Settings(**{**dict(environment="test",auth_enabled=True,allow_demo=True,app_origin=ORIGIN,database_url=database["runtime"],
        auth_database_url=database["auth"],session_secret="test-only-session-key-at-least-32-chars"),**overrides})
    app = create_app(config)
    with TestClient(app,base_url=config.app_origin) as client:
        yield client,app,config


def login(client,profile="aino"):
    response = client.post("/v1/auth/demo",json={"profile":profile},headers={"Origin":ORIGIN})
    assert response.status_code == 200,response.text
    return response
