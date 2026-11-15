import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2],port=Number(process.argv[3]??33152),apiPort=Number(process.argv[4]??18071);
if(!['build','start'].includes(mode)||![port,apiPort].every(n=>Number.isInteger(n)&&n>=1024&&n<=65535)||port===apiPort)throw Error('Use: node --env-file-if-exists=.env scripts/local_fresh_coach.mjs build|start [webPort] [localApiPort]');
const env={...process.env,MONEYLENS_NEXT_DIST:`.next/fresh-coach-${port}`,MONEYLENS_API_URL:`http://127.0.0.1:${apiPort}`,MONEY_COACH_PUBLIC_AI_ORIGINS:`http://127.0.0.1:${port}`,MONEY_COACH_PUBLIC_GEMINI_ENABLED:process.env.MONEY_COACH_PUBLIC_GEMINI_ENABLED??'false',MONEY_COACH_GEMINI_VOICE_ENABLED:process.env.MONEY_COACH_GEMINI_VOICE_ENABLED??'false',NEXT_TELEMETRY_DISABLED:'1'};
env.MONEY_COACH_MODEL_USAGE_PATH||=path.join(root,'.cache/model-usage.json');
env.MONEY_COACH_VOICE_LEDGER_PATH||=path.join(root,'.cache/voice-usage.json');
env.MONEY_COACH_VOICE_MAX_REQUESTS||='20';
// Reusing this private ledger across starts preserves the finite allowance.
env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH??=path.join(root,'.cache/public-ai-budget.json');
env.MONEY_COACH_PUBLIC_AI_MAX_REQUESTS??='20';
env.MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE??='6';
const child=spawn(process.execPath,['node_modules/next/dist/bin/next',mode,'frontend/web',...(mode==='start'?['--hostname','127.0.0.1','--port',String(port)]:[])],{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
