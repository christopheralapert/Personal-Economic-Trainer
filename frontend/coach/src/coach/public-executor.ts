import "server-only";
import path from "node:path";
import {loadDataset} from "@/engine/datasets";
import {scopedDataset} from "@/engine/data-scope";
import {withVoiceReservation} from "@/voice/budget";
import {publicAIPolicy,withPublicAIReservation} from "@/voice/public-budget";
import {VoiceError} from "@/voice/provider";
import {RuleProvider} from "./rule-provider";
import {ConversationProvider} from './conversation-provider';
import {throwIfCancelled,CoachCancelledError} from "./execution";
import {COACH_REVISION} from "./transport";
import type {createCoachExecutor} from "./server-executor";

/** Explicit public synthetic evaluation, independent of private and local-test grants. */
export function createPublicCoachExecutor({env=process.env,network=globalThis.fetch,readDataset=(_request:Request,key:string)=>loadDataset(key)}:{env?:Record<string,string|undefined>;network?:typeof fetch;readDataset?:(request:Request,key:string)=>ReturnType<typeof loadDataset>}={}){
 const execute:ReturnType<typeof createCoachExecutor>=async(request,question,locale,savingsPercent,context,period,scope,dataset,privacy,conversation)=>{
  const data=scopedDataset(await readDataset(request,dataset??"starter"),scope),execution={signal:request.signal,data,context,period};
  const fallback=async(diagnostic:string)=>({message:await new RuleProvider().answer(question,locale,savingsPercent,execution),source:"rule" as const,diagnostic});
  throwIfCancelled(request.signal);if(privacy!==false)return fallback("privacy_rule");
  const key=env.GEMINI_API_KEY,file=env.MONEY_COACH_MODEL_USAGE_PATH;
  if(env.MONEY_COACH_PUBLIC_GEMINI_ENABLED!=="true" || !key || !COACH_REVISION || !file || !path.isAbsolute(file))return fallback("public_configuration");
  try {
   const origin=request.headers.get("origin")??"",url=new URL(origin),allowed=(env.MONEY_COACH_PUBLIC_AI_ORIGINS??"").split(",").filter(Boolean).map(value=>{const parsed=new URL(value);if(parsed.origin!==value || !["https:","http:"].includes(parsed.protocol))throw new Error();return parsed.origin;});
   if(!allowed.includes(origin) || url.host!==request.headers.get("host"))return fallback("public_origin");
  }catch{return fallback("public_origin");}
  try {
   const policy=publicAIPolicy(env);
   const outcome=await withPublicAIReservation(policy,()=>withVoiceReservation(file,null,'coach',()=>new ConversationProvider(key,network).answer(question,locale,savingsPercent,execution,conversation)),request.signal);
   throwIfCancelled(request.signal);
   return {message:outcome.message,source:outcome.source,diagnostic:outcome.diagnostic,provider:outcome.source==='model'?'gemini-direct':undefined,usageDiagnostic:outcome.timing};
  }catch(error){throwIfCancelled(request.signal);if(error instanceof CoachCancelledError)throw error;return fallback(error instanceof VoiceError && error.code.startsWith("public_ai_")?error.code:error instanceof VoiceError && ["voice_busy","voice_ledger","voice_limit"].includes(error.code)?`public_ai_${error.code.slice(6)}`:"public_execution_failed");}
 };
 return execute;
}
