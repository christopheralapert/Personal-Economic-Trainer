import path from 'node:path';
import {pathToFileURL} from 'node:url';

const identityNames=['MONEYLENS_OIDC_ISSUER','MONEYLENS_OIDC_CLIENT_ID','MONEYLENS_OIDC_CLIENT_SECRET','MONEYLENS_OIDC_AUTHORIZATION_URL','MONEYLENS_OIDC_TOKEN_URL','MONEYLENS_OIDC_JWKS_URL'];
const positive=value=>/^[1-9][0-9]*$/u.test(value??'')&&Number.isSafeInteger(Number(value));
const configured=(env,key)=>typeof env[key]==='string'&&env[key].trim().length>0;
const pinnedHttps=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash&&!url.hostname.includes(':')&&!/^(?:[0-9]+\.){3}[0-9]+$/u.test(url.hostname)&&!/(?:^|\.)(?:example|invalid|localhost|test)(?:\.|$)/u.test(url.hostname);}catch{return false;}};

/** Configuration checks only. No keys, paths, URLs, statements or provider bodies enter the report. */
export async function releaseReadiness({env=process.env,probe=false,network=globalThis.fetch}={}){
 const results=[];
 for(const [feature,key] of [['Gemini','GEMINI_API_KEY'],['Nemotron','VERDA_INFERENCE_KEY']])results.push({feature,status:configured(env,key)?'configured_not_verified':'blocked',missing:configured(env,key)?[]:[key]});
 const missing=identityNames.filter(key=>!configured(env,key));
 const invalid=identityNames.filter(key=>/(?:ISSUER|_URL)$/u.test(key)&&configured(env,key)&&!pinnedHttps(env[key]));
 results.push({feature:'Real Auth0',status:missing.length||invalid.length?'blocked':'configured_not_verified',missing,invalid});
 const budgetNames=['MONEY_COACH_PUBLIC_AI_BUDGET_PATH','MONEY_COACH_PUBLIC_AI_MAX_REQUESTS','MONEY_COACH_MODEL_USAGE_PATH','MONEY_COACH_VOICE_LEDGER_PATH','MONEY_COACH_VOICE_MAX_REQUESTS'];
 const budgetMissing=budgetNames.filter(key=>!configured(env,key));
 const invalidBudget=budgetNames.filter(key=>configured(env,key)&&(/_PATH$/u.test(key)?!path.isAbsolute(env[key]):!positive(env[key])));
 results.push({feature:'Local AI admission controls',status:budgetMissing.length||invalidBudget.length?'blocked':'configured_not_verified',missing:budgetMissing,invalid:invalidBudget,note:'Provider-side billing limits still need operator verification.'});
 if(probe)for(const [feature,url] of [['Google HTTPS','https://generativelanguage.googleapis.com'],['Verda HTTPS','https://containers.datacrunch.io']]){
  const started=performance.now();
  try{const response=await network(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(5000),cache:'no-store'});await response.body?.cancel();results.push({feature,status:'network_reachable',httpStatus:response.status,elapsedMs:Math.round(performance.now()-started),note:'Not a model, tool-call or audio verification.'});}
  catch(error){const allowed=['EACCES','EPERM','ENOTFOUND','ECONNREFUSED','ETIMEDOUT','ENETUNREACH'];let cause=error,code='network_unavailable';for(let depth=0;depth<6&&cause&&typeof cause==='object';depth++,cause=cause.cause){if(allowed.includes(cause.code)){code=cause.code;break;}if(cause.name==='TimeoutError')code='timeout';}results.push({feature,status:'blocked',code,elapsedMs:Math.round(performance.now()-started)});}
 }
 for(const feature of ['Physical microphone, playback and PWA installation','New-user usability review','Backup restore and production security review'])results.push({feature,status:'manual_verification_required'});
 return {configurationOnly:true,liveInferencePerformed:false,results};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const args=process.argv.slice(2);if(args.some(value=>value!=='--probe'))throw new Error('Use: node --env-file-if-exists=.env scripts/release_readiness.mjs [--probe]');
 const report=await releaseReadiness({probe:args.includes('--probe')});
 process.stdout.write(JSON.stringify(report,null,2)+'\n');
 process.exitCode=report.results.some(result=>result.status==='blocked')?1:0;
}
