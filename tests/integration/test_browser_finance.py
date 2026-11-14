"""Opt-in production browser journey over fixture-owned SQL and real bank workers."""
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys

import psycopg
import pytest

from app.identity import DEMO_ISSUER

ROOT=Path(__file__).resolve().parents[2]


def stop(process):
    if process.poll() is not None:
        return
    if os.name=="nt":
        # Only this fixture's still-running subprocess tree, never a port owner.
        subprocess.run(["taskkill","/PID",str(process.pid),"/T","/F"],capture_output=True,timeout=10)
    else:
        os.killpg(process.pid,signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name!="nt":
            os.killpg(process.pid,signal.SIGKILL)
        else:
            process.kill()
        process.wait(timeout=10)


@pytest.mark.skipif(os.environ.get("MONEYLENS_BROWSER_FINANCE")!="true",reason="Opt-in production browser journey requires Node, browser and a production build")
def test_real_two_bank_browser_planning_and_revocation(database,owners):
    node=shutil.which("node")
    assert node and (ROOT/"frontend/web/.next/BUILD_ID").is_file(),"Install Node dependencies and run npm run build first."
    with psycopg.connect(database["admin"]) as connection:
        for owner,subject,name in zip(owners[:2],("aino.v1","mika.v1"),("Synthetic Aino","Synthetic Mika")):
            connection.execute("""UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,is_synthetic=true,
                display_name=%s WHERE tenant_id=%s AND id=%s""",(DEMO_ISSUER,subject,name,*owner[:2]))
        # The integration fixture's initial empty account has no financial facts.
        # Remove only this test-owned empty row; published banks create both accounts.
        connection.execute("DELETE FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s AND id=%s",owners[0])
    environment={**os.environ,
        "MONEYLENS_ENVIRONMENT":"test","MONEYLENS_ALLOW_DEMO":"true","MONEYLENS_AUTH_ENABLED":"true",
        "MONEYLENS_DATABASE_URL":database["runtime"],"MONEYLENS_AUTH_DATABASE_URL":database["auth"],
        "MONEYLENS_SESSION_SECRET":"isolated-browser-session-secret-not-for-production",
        "MONEYLENS_MODEL_ENABLED":"false","MONEYLENS_MODEL_BILLING_POLICY":"free_only",
        "MONEYLENS_OPENAI_API_KEY":"fake-finance-browser-key-no-provider-usage",
        "MONEYLENS_BROWSER_FINANCE":"true","NEXT_TELEMETRY_DISABLED":"1",
    }
    process_options={"cwd":ROOT,"env":environment,"stdout":subprocess.PIPE,"stderr":subprocess.STDOUT,"text":True,
        "creationflags":subprocess.CREATE_NEW_PROCESS_GROUP} if os.name=="nt" else {
        "cwd":ROOT,"env":environment,"stdout":subprocess.PIPE,"stderr":subprocess.STDOUT,"text":True,"start_new_session":True}
    worker=subprocess.Popen([sys.executable,str(ROOT/"backend/workers/run.py"),"--tenant",str(owners[0][0]),
        "--user",str(owners[0][1]),"--bank-sync"],**process_options)
    coaching=None;browser=None
    try:
        coaching=subprocess.Popen([sys.executable,str(ROOT/"backend/workers/run.py"),"--tenant",str(owners[0][0]),
            "--user",str(owners[0][1]),"--coaching"],**process_options)
        browser=subprocess.Popen([node,str(ROOT/"node_modules/@playwright/test/cli.js"),"test","--config=playwright.finance.config.ts"],**process_options)
        try:
            output,_=browser.communicate(timeout=180)
        except subprocess.TimeoutExpired:
            pytest.fail("The isolated finance browser journey timed out.")
        assert browser.returncode==0,output[-12000:]
        assert worker.poll() is None,"The real scoped bank worker stopped during the journey."
        assert coaching.poll() is None,"The scoped coaching worker stopped during the journey."
        with psycopg.connect(database["admin"]) as connection:
            counts=connection.execute("""SELECT
                (SELECT count(*) FROM moneylens.accounts WHERE tenant_id=%s AND owner_user_id=%s),
                (SELECT count(*) FROM moneylens.balance_snapshots WHERE tenant_id=%s AND owner_user_id=%s),
                (SELECT count(*) FROM moneylens.jobs WHERE tenant_id=%s AND owner_user_id=%s AND type='bank.publish' AND state='completed'),
                (SELECT count(*) FROM moneylens.allocations WHERE tenant_id=%s AND owner_user_id=%s AND state='released')""",owners[0][:2]*4).fetchone()
            assert counts==(2,2,2,1)
            assert connection.execute("SELECT coaching_enabled,version,delivery_mode FROM moneylens.coaching_preferences WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(False,3,"in_app_only")
            assert connection.execute("SELECT count(*) FROM moneylens.coaching_commands WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(2,)
            assert connection.execute("SELECT count(*) FROM moneylens.insights WHERE tenant_id=%s AND owner_user_id=%s",owners[0][:2]).fetchone()==(0,)
    finally:
        if browser is not None:
            stop(browser)
            if browser.stdout:
                browser.stdout.close()
        stop(worker)
        if worker.stdout:
            worker.stdout.close()
        if coaching is not None:
            stop(coaching)
            if coaching.stdout:
                coaching.stdout.close()
