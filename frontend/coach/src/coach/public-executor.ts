import "server-only";
import path from "node:path";
import {createOpenAI} from "@ai-sdk/openai";
import {createGeminiNativeTransport} from "../../scripts/gemini-native.mjs";
import {createGuardedTransport,GEMINI_MODEL,GEMINI_MAX_OUTPUT_TOKENS} from "../../scripts/guarded-transport.mjs";
import {loadDataset} from "@/engine/datasets";
import {scopedDataset} from "@/engine/data-scope";
import {sourceDate} from "@/engine/source-date";
import {withVoiceReservation} from "@/voice/budget";
import {RuleProvider} from "./rule-provider";
import {LLMProvider} from "./llm-provider";
import {resolveQuestion} from "./resolve-question";
import {throwIfCancelled,CoachCancelledError} from "./execution";
import {COACH_REVISION} from "./transport";
import type {createCoachExecutor} from "./server-executor";

/** Explicit public synthetic evaluation, independent of private and local-test grants. */
export function createPublicCoachExecutor({env=process.env,network=globalThis.fetch,readDataset=(_request:Request,key:string)=>loadDataset(key)}:{env?:Record<string,string|undefined>;network?:typeof fetch;readDataset?:(request:Request,key:string)=>ReturnType<typeof loadDataset>}={}){
 const execute:ReturnType<typeof createCoachExecutor>=async(request,question,locale,savingsPercent,context,period,scope,dataset,privacy)=>{
  const data=scopedDataset(await readDataset(request,dataset??"starter"),scope),execution={signal:request.signal,data,context,period};
  const fallback=async(diagnostic:string)=>({message:await new RuleProvider().answer(question,locale,savingsPercent,execution),source:"rule" as const,diagnostic});
  throwIfCancelled(request.signal);if(privacy!==false)return fallback("privacy_rule");
  const key=env.GEMINI_API_KEY,file=env.MONEY_COACH_MODEL_USAGE_PATH;
  if(env.MONEY_COACH_PUBLIC_GEMINI_ENABLED!=="true" || !key || !COACH_REVISION || !file || !path.isAbsolute(file))return fallback("public_configuration");
  try {
   const origin=request.headers.get("origin")??"",url=new URL(origin),allowed=(env.MONEY_COACH_PUBLIC_AI_ORIGINS??"").split(",").filter(Boolean).map(value=>{const parsed=new URL(value);if(parsed.origin!==value || !["https:","http:"].includes(parsed.protocol))throw new Error();return parsed.origin;});
   if(!allowed.includes(origin) || url.host!==request.headers.get("host"))return fallback("public_origin");
  }catch{return fallback("public_origin");}
  const intent=resolveQuestion(question,context,period,sourceDate(data.as_of));
  if(intent.status==="clarification_required" || (intent.status==="unsupported" && intent.reason==="INVALID_QUESTION"))return fallback("clarification");
  const native=createGeminiNativeTransport(network),transport=createGuardedTransport({provider:"gemini",nonStreaming:true,network:native,budget:{reserve:async()=>"public-evaluation",settle:async()=>{}}});
  try {
   const result=await withVoiceReservation(file,null,"coach",async()=>{
    const model=createOpenAI({apiKey:key,baseURL:"https://generativelanguage.googleapis.com/v1beta/openai",fetch:transport.fetch}).chat(GEMINI_MODEL);
    const outcome=await new LLMProvider(model,{nonStreaming:true,maxOutputTokens:GEMINI_MAX_OUTPUT_TOKENS}).answerWithOutcome(question,locale,savingsPercent,execution);
    await transport.settle(outcome.usage,outcome.reason);throwIfCancelled(request.signal);
    const receipt=outcome.usage,usage=receipt && receipt.inputTokens!==null && receipt.outputTokens!==null && receipt.totalTokens!==null && receipt.totalTokens>0 ? {total_input_tokens:receipt.inputTokens,total_output_tokens:receipt.outputTokens,total_tokens:receipt.totalTokens} : null;
    return {outcome,usage};
   });
   const outcome=result.outcome,snapshot=transport.snapshot();
   const diagnostic=outcome.source==="model" ? "model_tool" : snapshot.failure ? [snapshot.failure,snapshot.httpStatus,snapshot.providerCode,snapshot.providerHint,snapshot.providerField].filter(Boolean).join(":") : outcome.failureStage??outcome.reason;
   return {message:outcome.message,source:outcome.source,diagnostic,provider:outcome.source==="model" ? "gemini-direct" : undefined,usageDiagnostic:native.diagnostics()};
  }catch(error){if(error instanceof CoachCancelledError)throw error;return fallback("public_execution_failed");}
 };
 return execute;
}
