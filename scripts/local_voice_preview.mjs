import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import net from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url)),mode=process.argv[2],port=Number(process.argv[3]??33133);
if(!['build','start'].includes(mode)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Use: node scripts/local_voice_preview.mjs build|start [port]');
const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!['MONEYLENS_','MONEY_COACH_','GEMINI_','VERDA_','OPENAI_','NEXT_PUBLIC_'].some(prefix=>name.startsWith(prefix))));
Object.assign(env,{MONEYLENS_NEXT_DIST:`.next/voice-flow-${port}`,MONEYLENS_API_URL:'http://127.0.0.1:9',MONEY_COACH_PUBLIC_GEMINI_ENABLED:'true',MONEY_COACH_PUBLIC_AI_ORIGINS:`http://127.0.0.1:${port}`,MONEY_COACH_MODEL_USAGE_PATH:path.join(root,'.cache',`voice-flow-${port}-text.json`),MONEY_COACH_GEMINI_VOICE_ENABLED:'true',MONEY_COACH_VOICE_LEDGER_PATH:path.join(root,'.cache',`voice-flow-${port}-audio.json`),MONEY_COACH_VOICE_MAX_REQUESTS:'40',NEXT_TELEMETRY_DISABLED:'1'});
if(mode==='start'){
 const settings=parseEnv(readFileSync(path.join(root,'.env'),'utf8'));
 if(!settings.GEMINI_API_KEY)throw Error('GEMINI_API_KEY: missing');
 env.GEMINI_API_KEY=settings.GEMINI_API_KEY;
 if(settings.VERDA_INFERENCE_KEY){env.VERDA_INFERENCE_KEY=settings.VERDA_INFERENCE_KEY;env.MONEY_COACH_GENERATED_LANGUAGES_ENABLED='true';}
 console.log('GEMINI_API_KEY: loaded server-side from root .env');
 const probe=net.createServer();await new Promise((resolve,reject)=>{probe.once('error',()=>reject(Error(`Port ${port} occupied; no server stopped`)));probe.listen(port,'127.0.0.1',()=>probe.close(resolve));});
}
const child=spawn(process.execPath,['node_modules/next/dist/bin/next',mode,'frontend/web',...(mode==='start'?['--hostname','127.0.0.1','--port',String(port)]:[])],{cwd:root,env,stdio:'inherit',windowsHide:true});
child.on('exit',code=>process.exitCode=code??1);for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
