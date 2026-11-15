import "server-only";
import {mkdir,open,readFile,rename,unlink} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {VoiceError} from "./provider";

type Environment=Record<string,string|undefined>;
export type PublicAIPolicy={file:string;maximumRequests:number;requestsPerMinute:number;maximumMicroEUR:number|null;reservationMicroEUR:number};
const count=z.number().int().nonnegative().safe();
const ledgerSchema=z.object({version:z.literal(1),requests:count,reservedMicroEUR:count,recent:z.array(count).max(60)}).strict();
function positive(value:string|undefined,maximum=Number.MAX_SAFE_INTEGER){
 if(value===undefined || !/^[1-9]\d*$/.test(value))throw new VoiceError("public_ai_configuration",503);
 const parsed=Number(value);if(!Number.isSafeInteger(parsed)||parsed>maximum)throw new VoiceError("public_ai_configuration",503);return parsed;
}

/** No key or enablement flag implicitly grants an allowance. Money is reservation accounting, not a provider price quote. */
export function publicAIPolicy(env:Environment):PublicAIPolicy{
 const file=env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH;
 if(!file || !path.isAbsolute(file) || file===env.MONEY_COACH_MODEL_USAGE_PATH || file===env.MONEY_COACH_VOICE_LEDGER_PATH)throw new VoiceError("public_ai_configuration",503);
 const maximumRequests=positive(env.MONEY_COACH_PUBLIC_AI_MAX_REQUESTS,10000),requestsPerMinute=positive(env.MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE??"6",60);
 const budget=env.MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR,reservation=env.MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR;
 if(budget===undefined && reservation===undefined)return {file,maximumRequests,requestsPerMinute,maximumMicroEUR:null,reservationMicroEUR:0};
 const maximumMicroEUR=positive(budget),reservationMicroEUR=positive(reservation);
 if(reservationMicroEUR>maximumMicroEUR)throw new VoiceError("public_ai_configuration",503);
 return {file,maximumRequests,requestsPerMinute,maximumMicroEUR,reservationMicroEUR};
}

/** One shared writer across text/voice and processes. Reserve durably before transport; never refund failures, cancellations or missing receipts.
 * The lifetime allowance never resets automatically. A crashed writer leaves its lock in place for operator review.
 */
export async function withPublicAIReservation<T>(policy:PublicAIPolicy,run:()=>Promise<T>,signal?:AbortSignal,now=Date.now):Promise<T>{
 const {file}=policy;
 try{await mkdir(path.dirname(file),{recursive:true});}catch{throw new VoiceError("public_ai_ledger",503);}
 let lock;try{lock=await open(file+".lock","wx",0o600);}catch(error){throw new VoiceError((error as NodeJS.ErrnoException).code==="EEXIST"?"public_ai_busy":"public_ai_ledger",(error as NodeJS.ErrnoException).code==="EEXIST"?429:503,"5");}
 let retainLock=false;
 try{
  signal?.throwIfAborted();
  let state:z.infer<typeof ledgerSchema>={version:1,requests:0,reservedMicroEUR:0,recent:[]};
  try{state=ledgerSchema.parse(JSON.parse(await readFile(file,"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new VoiceError("public_ai_ledger",503);}
  const instant=now();
  if(!Number.isSafeInteger(instant)||instant<0||state.requests<state.recent.length||state.recent.some((at,index)=>at>instant || index>0&&at<state.recent[index-1]) || state.requests>0&&state.recent.length===0 || state.requests===0&&state.reservedMicroEUR!==0)throw new VoiceError("public_ai_ledger",503);
  if(state.requests>=policy.maximumRequests)throw new VoiceError("public_ai_request_limit",429);
  if(!Number.isSafeInteger(state.reservedMicroEUR+policy.reservationMicroEUR) || policy.maximumMicroEUR!==null && state.reservedMicroEUR+policy.reservationMicroEUR>policy.maximumMicroEUR)throw new VoiceError("public_ai_budget_limit",429);
  const recent=state.recent.filter(at=>instant-at<60000);
  if(recent.length>=policy.requestsPerMinute)throw new VoiceError("public_ai_rate_limit",429,String(Math.max(1,Math.ceil((recent[0]+60000-instant)/1000))));
  state={...state,requests:state.requests+1,reservedMicroEUR:state.reservedMicroEUR+policy.reservationMicroEUR,recent:[...recent,instant]};
  try{
   const temporary=await open(file+".next","wx",0o600);
   try{await temporary.writeFile(JSON.stringify(state));await temporary.sync();}finally{await temporary.close();}
   await rename(file+".next",file);
  }catch{retainLock=true;throw new VoiceError("public_ai_ledger",503);}
  signal?.throwIfAborted();
  return await run();
 }finally{
  await lock.close();if(!retainLock)await unlink(file+".lock");
 }
}
