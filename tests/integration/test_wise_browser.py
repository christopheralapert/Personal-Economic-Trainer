import os, subprocess, time, sys
from pathlib import Path
import psycopg,httpx,pytest
from app.identity import DEMO_ISSUER

ROOT=Path(__file__).resolve().parents[2]

@pytest.mark.skipif(os.environ.get('MONEYLENS_STATEMENT_BROWSER_TEST') != 'true',reason='Requires a dedicated built test frontend and isolated API')
def test_browser_wise_import_against_isolated_api_and_postgres(database,owners):
    for url in ('http://127.0.0.1:33111/','http://127.0.0.1:18030/health/live'):
        try: httpx.get(url,timeout=.3)
        except httpx.HTTPError: continue
        raise AssertionError('Test port already in use; no processes were stopped')
    with psycopg.connect(database['admin'],autocommit=True) as conn:
        for owner,subject in zip(owners[:2],('aino.v1','mika.v1')):
            conn.execute('UPDATE moneylens.users SET subject_issuer=%s,subject_id=%s,is_synthetic=true WHERE tenant_id=%s AND id=%s',(DEMO_ISSUER,subject,*owner[:2]))
    clean={k:v for k,v in os.environ.items() if not k.startswith('MONEYLENS_')}
    api={**clean,'MONEYLENS_ENVIRONMENT':'test','MONEYLENS_AUTH_ENABLED':'true','MONEYLENS_ALLOW_DEMO':'true','MONEYLENS_APP_ORIGIN':'http://127.0.0.1:33111','MONEYLENS_DATABASE_URL':database['runtime'],'MONEYLENS_AUTH_DATABASE_URL':database['auth'],'MONEYLENS_SESSION_SECRET':'only-for-this-isolated-test-32-characters','MONEYLENS_STATEMENT_IMPORTS_ENABLED':'true'}
    web={**clean,'MONEYLENS_STATEMENT_BROWSER_TEST':'true','MONEYLENS_NEXT_DIST':'.next-statement-test','MONEYLENS_API_URL':'http://127.0.0.1:18030','MONEYLENS_ALLOW_DEMO':'true'}
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    procs=[]
    try:
        procs.append(subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--app-dir','services/api','--host','127.0.0.1','--port','18030','--no-access-log'],cwd=ROOT,env=api,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags))
        procs.append(subprocess.Popen(['node','node_modules/next/dist/bin/next','start','apps/web','--hostname','127.0.0.1','--port','33111'],cwd=ROOT,env=web,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags))
        for url in ('http://127.0.0.1:18030/health/ready','http://127.0.0.1:33111/'):
            for _ in range(100):
                try:
                    if httpx.get(url,timeout=1).status_code==200:break
                except httpx.HTTPError:pass
                time.sleep(.2)
            else:raise AssertionError('Isolated test server did not start')
        run=subprocess.run(['npx.cmd','playwright','test','--config','.cache/wise-browser.config.ts','--reporter=line'],cwd=ROOT,env=web,timeout=100,creationflags=flags,capture_output=True,text=True)
        assert run.returncode==0, (run.stdout+run.stderr)[-5000:]
    finally:
        for process in procs:process.terminate()
        for process in procs:
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait()
