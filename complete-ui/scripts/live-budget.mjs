import {createHash,randomUUID} from "node:crypto";
import {mkdir,open,readFile,rename,unlink,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {privateHTTPSOrigin} from "./phone-ai-access.mjs";

export const MODEL="gpt-4.1-mini";
export const DAILY_TOKENS=2500000;
export const MAX_COST_MICRO_EUR=1000000;
export const MAX_INPUT_TOKENS=1047576;
export const MAX_OUTPUT_TOKENS=512;
// Standard input/output prices: $0.40/$1.60 per million tokens. Count every
// token as paid, with a deliberately conservative 2 EUR/USD conversion buffer.
export const costMicroEUR=(input,output)=>Math.ceil((input*400+output*1600)*2/1000);
export const REQUEST_COST_MICRO_EUR=costMicroEUR(MAX_INPUT_TOKENS,MAX_OUTPUT_TOKENS);
// Published full context window plus the configured output cap, deliberately
// conservative. Missing receipts retain the whole reservation; no estimates.
export const REQUEST_RESERVATION=MAX_INPUT_TOKENS+MAX_OUTPUT_TOKENS;
export const MAX_ATTEMPTS=40;
export const liveDirectory=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../..", ".cache/money-coach-ai");
export const keyFingerprint=key=>createHash("sha256").update(key).digest("hex");
const denied=code=>Object.assign(new Error(code),{code});
const integer=value=>Number.isSafeInteger(value) && value>=0;

export async function openBudget({directory=liveDirectory,key,now=()=>new Date(),requiredOrigin,requiredRevision}={}) {
  if(!key || typeof key!=="string") throw denied("missing_key");
  await mkdir(directory,{recursive:true});
  const lockPath=path.join(directory,"session.lock");
  let lock;try {lock=await open(lockPath,"wx");} catch {throw denied("budget_locked");}
  let closed=false;
  const close=async({retainLock=false}={})=>{if(!closed) {closed=true;await lock.close();if(!retainLock) await unlink(lockPath);}};
  try {
    const filename=path.join(directory,"allowance.json");
    const state=JSON.parse(await readFile(filename,"utf8"));
    const phoneGrant=state.phoneEvaluationAuthorized===true && state.phoneStartAttempts===40 && state.maxAttempts===60 && privateHTTPSOrigin(state.interactiveOrigin) && Date.parse(state.expiresAt)-Date.parse(state.confirmedAt)<=3600000;
    const attemptLimit=phoneGrant ? 60 : MAX_ATTEMPTS;
    if(state.version!==1 || state.model!==MODEL || state.dailyTokens!==DAILY_TOKENS || state.maxAttempts!==attemptLimit ||
      state.maximumCostMicroEUR!==MAX_COST_MICRO_EUR || state.paidEvaluationAuthorized!==true ||
      state.keyFingerprint!==keyFingerprint(key) || state.sharingConfirmed!==true || state.exclusiveUsageConfirmed!==true ||
      state.initialUsageTokens!==0 || !Array.isArray(state.attempts) || state.attempts.length>attemptLimit || phoneGrant && state.attempts.length<40) throw denied("invalid_grant");
    if(requiredOrigin!==undefined && (state.interactiveOrigin!==requiredOrigin || typeof requiredOrigin!=="string")) throw denied("interactive_grant_mismatch");
    if(requiredRevision!==undefined && (state.interactiveRevision!==requiredRevision || typeof requiredRevision!=="string")) throw denied("interactive_grant_mismatch");
    const granted=Date.parse(state.confirmedAt),expiry=Date.parse(state.expiresAt);
    if(!Number.isFinite(granted) || !Number.isFinite(expiry) || expiry<=granted || expiry-granted>86400000) throw denied("invalid_grant");
    const used=()=>state.attempts.reduce((total,attempt)=>{
      if(typeof attempt.id!=="string" || !["reserved","completed","unknown"].includes(attempt.status) ||
        !integer(attempt.countedTokens) || attempt.countedTokens>REQUEST_RESERVATION ||
        !integer(attempt.countedCostMicroEUR) ||
        (attempt.status!=="completed" && (attempt.countedTokens!==REQUEST_RESERVATION || attempt.countedCostMicroEUR!==REQUEST_COST_MICRO_EUR)) ||
        (attempt.status==="completed" && (!integer(attempt.inputTokens) || !integer(attempt.outputTokens) || attempt.inputTokens>MAX_INPUT_TOKENS || attempt.outputTokens>MAX_OUTPUT_TOKENS ||
          attempt.inputTokens+attempt.outputTokens!==attempt.countedTokens || attempt.countedCostMicroEUR!==costMicroEUR(attempt.inputTokens,attempt.outputTokens)))) throw denied("invalid_ledger");
      return total+attempt.countedTokens;
    },0);
    const spent=()=>state.attempts.reduce((total,attempt)=>total+attempt.countedCostMicroEUR,0);
    if(used()>DAILY_TOKENS || spent()>MAX_COST_MICRO_EUR) throw denied("invalid_ledger");
    const assertCurrent=()=>{
      const instant=now().getTime();
      if(closed || instant<granted || instant>=expiry) throw denied("grant_expired");
      if(state.halted || state.attempts.some(attempt=>attempt.status!=="completed")) throw denied("budget_halted");
    };
    assertCurrent();
    const save=async()=>{
      const temporary=filename+"."+randomUUID()+".tmp";
      await writeFile(temporary,JSON.stringify(state,null,2)+"\n",{flag:"wx"});
      await rename(temporary,filename);
    };
    return {
      async reserve() {
        assertCurrent();
        if(state.attempts.length>=attemptLimit || used()+REQUEST_RESERVATION>DAILY_TOKENS) throw denied("allowance_exhausted");
        if(spent()+REQUEST_COST_MICRO_EUR>MAX_COST_MICRO_EUR) throw denied("cost_exhausted");
        const id=randomUUID();state.attempts.push({id,status:"reserved",countedTokens:REQUEST_RESERVATION,countedCostMicroEUR:REQUEST_COST_MICRO_EUR,startedAt:now().toISOString()});
        await save();return id;
      },
      async settle(id,usage,reason) {
        const attempt=state.attempts.find(item=>item.id===id);
        if(!attempt || attempt.status!=="reserved") throw denied("invalid_settlement");
        const input=usage?.inputTokens,output=usage?.outputTokens,total=usage?.totalTokens;
        if(integer(input) && integer(output) && integer(total) && total>0 && total===input+output && input<=MAX_INPUT_TOKENS && output<=MAX_OUTPUT_TOKENS) {
          Object.assign(attempt,{status:"completed",countedTokens:total,countedCostMicroEUR:costMicroEUR(input,output),inputTokens:input,outputTokens:output});
        } else {attempt.status="unknown";state.halted="missing_or_invalid_usage";}
        attempt.result=reason;await save();
      },
      async halt(reason) {state.halted=reason;await save();},
      summary:()=>({model:MODEL,attempts:state.attempts.length,countedTokens:used(),dailyTokens:DAILY_TOKENS,countedCostMicroEUR:spent(),maximumCostMicroEUR:MAX_COST_MICRO_EUR,expiresAt:state.expiresAt,halted:state.halted ?? null}),
      close,
    };
  } catch(error) {await close();throw error;}
}
