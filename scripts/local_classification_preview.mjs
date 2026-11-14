import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),[mode,...options]=process.argv.slice(2);
if(!['build','start'].includes(mode)||options.some(option=>option!=='--live-classification'))throw Error('Use: node scripts/local_classification_preview.mjs build|start [--live-classification]');
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!['MONEYLENS_','MONEY_COACH_','GEMINI_','VERDA_','OPENAI_','NEXT_PUBLIC_'].some(prefix=>name.startsWith(prefix))));
Object.assign(env,{MONEYLENS_NEXT_DIST:'.next/auto-classification-33132',MONEYLENS_API_URL:'http://127.0.0.1:18052',MONEY_COACH_PUBLIC_GEMINI_ENABLED:'false',MONEY_COACH_GEMINI_VOICE_ENABLED:'false',MONEY_COACH_LOCAL_AI_EVALUATION:'false',NEXT_TELEMETRY_DISABLED:'1'});
const live=options.includes('--live-classification');
if(mode==='start'){
 env.MONEYLENS_TEST_DATABASE_URL=process.env.MONEYLENS_TEST_DATABASE_URL??'postgresql://moneylens_test_admin:synthetic_test_only@127.0.0.1:55440/postgres';
 if(live){const settings=parseEnv(readFileSync(path.join(root,'.env'),'utf8'));if(!settings.GEMINI_API_KEY)throw Error('GEMINI_API_KEY: missing');env.GEMINI_API_KEY=settings.GEMINI_API_KEY;console.log('GEMINI_API_KEY: root .env, server-side classification only');}
}
const child=spawn(mode==='build'?process.execPath:path.join(root,'.venv/Scripts/python.exe'),mode==='build'?['node_modules/next/dist/bin/next','build','frontend/web']:['scripts/run_guard_preview.py','--test-only','--port','33132','--api-port','18052','--dist','.next/auto-classification-33132','--classification-model',live?'live':'mock'],{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
