import "server-only";
import path from "node:path";
import {createOpenAI} from "@ai-sdk/openai";
import {openBudget,MODEL} from "../../scripts/live-budget.mjs";
import {createGuardedTransport,GEMINI_MODEL,GEMINI_MAX_OUTPUT_TOKENS} from "../../scripts/guarded-transport.mjs";
import {mockGeminiFetch} from "../../scripts/gemini-mock.mjs";
import {createGeminiNativeTransport} from "../../scripts/gemini-native.mjs";
import {LLMProvider} from "./llm-provider";
import {RuleProvider} from "./rule-provider";
import {CoachCancelledError,throwIfCancelled} from "./execution";
import {COACH_REVISION} from "./transport";
import type {Locale} from "@/i18n/dictionaries";
import type {QuestionContext} from "./question-context";

import {loadDataset,type DatasetKey} from "@/engine/datasets";
import {type Period} from "@/engine";
import {scopedDataset,type DataScope} from "@/engine/data-scope";
import {privateHTTPSOrigin,phoneCookieMatches} from "../../scripts/phone-ai-access.mjs";
type Dependencies={env?:Record<string,string|undefined>;open?:typeof openBudget;network?:typeof fetch};
/** Server-only, loopback evaluation composition. A flag/key never grants a request. */
export function createCoachExecutor({env=process.env,open=openBudget,network=globalThis.fetch}:Dependencies={}) {
  return async(request:Request,question:string,locale:Locale,savingsPercent:number,context?:QuestionContext,period?:Period,scope?:DataScope,dataset?:DatasetKey)=>{
    const execution={signal:request.signal,context,period,data:scope===undefined && dataset===undefined ? undefined : scopedDataset(await loadDataset(dataset??"starter"),scope)};
    const fallback=async(diagnostic="local_rule")=>({message:await new RuleProvider().answer(question,locale,savingsPercent,execution),source:"rule" as const,diagnostic});
    throwIfCancelled(request.signal);
    const gemini=env.MONEY_COACH_LOCAL_GEMINI==="true",origin=env.MONEY_COACH_LOCAL_AI_ORIGIN,directory=env.MONEY_COACH_EVALUATION_DIRECTORY,key=gemini ? env.GEMINI_API_KEY : env.MONEYLENS_OPENAI_API_KEY;
    if(env.MONEY_COACH_LOCAL_AI_EVALUATION!=="true" || !origin || !key || !COACH_REVISION || (!gemini && (env.MONEYLENS_MODEL_BILLING_POLICY!=="free_only" || !directory || !path.isAbsolute(directory))) || (gemini && (dataset!=="organizer1" || env.MONEY_COACH_PHONE_AI_EVALUATION==="true"))) return fallback("local_configuration");
    try {
      const configured=new URL(origin),actual=new URL(request.url);
      const phone=env.MONEY_COACH_PHONE_AI_EVALUATION==="true" && privateHTTPSOrigin(origin);
      if(phone && !phoneCookieMatches(request.headers.get("cookie"),env.MONEY_COACH_PHONE_AI_SECRET)) return fallback("phone_pairing");
      if(!phone && (configured.origin!==origin || configured.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(configured.hostname))) return fallback("configured_origin");
      // Next can normalize the internal request hostname to localhost. The
      // browser Origin/Host must still exactly match the configured address.
      if(!["http:",...(phone ? ["https:"] : [])].includes(actual.protocol) || !["127.0.0.1","localhost","[::1]",...(phone ? [configured.hostname] : [])].includes(actual.hostname) || actual.port!==configured.port) return fallback("request_origin");
      if(request.headers.get("host")!==configured.host || request.headers.get("origin")!==origin) return fallback("request_headers");
    } catch {return fallback("invalid_origin");}
    if(gemini) {
      // Only the explicitly launched loopback test opts into this provider. The
      // OpenAI grant and its cost ledger are neither modified nor reused.
      const budget={reserve:async()=>"local-test",settle:async()=>{}};
      const mocked=env.MONEY_COACH_GEMINI_MOCK==="true";
      const native=createGeminiNativeTransport(mocked ? mockGeminiFetch : network);
      const transport=createGuardedTransport({budget,provider:"gemini",nonStreaming:true,network:native});
      try {
        const model=createOpenAI({apiKey:key,baseURL:"https://generativelanguage.googleapis.com/v1beta/openai",fetch:transport.fetch}).chat(GEMINI_MODEL);
        const outcome=await new LLMProvider(model,{nonStreaming:true,maxOutputTokens:GEMINI_MAX_OUTPUT_TOKENS}).answerWithOutcome(question,locale,savingsPercent,execution);
        await transport.settle(outcome.usage,outcome.reason);
        throwIfCancelled(request.signal);
        const snapshot=transport.snapshot(),status=snapshot.httpStatus;
        const diagnostic=outcome.source==="rule" && snapshot.failure ? [snapshot.failure,status,snapshot.providerCode,snapshot.providerHint,snapshot.providerField].filter(Boolean).join(":") : outcome.source==="rule" && outcome.failureStage ? outcome.failureStage : outcome.reason;
        return {message:outcome.message,source:outcome.source,diagnostic,usageDiagnostic:native.diagnostics(),provider:outcome.source==="model" ? (mocked ? "gemini-direct-mock" : "gemini-direct") : undefined};
      } catch(error) {
        if(error instanceof CoachCancelledError) throw error;
        return fallback("gemini_execution_failed");
      }
    }
    let budget:Awaited<ReturnType<typeof openBudget>>;
    try {budget=await open({directory,key,requiredOrigin:origin,requiredRevision:COACH_REVISION});} catch(error) {
      const code=(error as {code?:string})?.code;
      return fallback(code && ["interactive_grant_mismatch","budget_halted","invalid_grant","grant_expired","budget_locked"].includes(code) ? code : "grant_unavailable");
    }
    const transport=createGuardedTransport({budget,network});
    let receiptSaved=false,retainLock=false;
    const halt=async(reason:string)=>{try {await budget.halt(reason);} catch {retainLock=true;}};
    try {
      throwIfCancelled(request.signal);
      const model=createOpenAI({apiKey:key,baseURL:"https://api.openai.com/v1",fetch:transport.fetch}).chat(MODEL);
      const outcome=await new LLMProvider(model).answerWithOutcome(question,locale,savingsPercent,execution);
      await transport.settle(outcome.usage,outcome.reason);
      receiptSaved=true;
      if(transport.snapshot().fetches && ["invalid_or_failed_tool","timeout"].includes(outcome.reason) && !budget.summary().halted) await halt("interactive_evaluation_failed");
      throwIfCancelled(request.signal);
      return {message:outcome.message,source:outcome.source,diagnostic:outcome.reason};
    } catch(error) {
      if(transport.snapshot().settled && !receiptSaved) retainLock=true;
      if(!transport.snapshot().settled) {try {await transport.settle(null,"interrupted");} catch {retainLock=true;}}
      if(transport.snapshot().fetches) await halt("interactive_evaluation_interrupted");
      if(error instanceof CoachCancelledError) throw error;
      return fallback("execution_failed");
    } finally {
      // A retained lock on cleanup failure denies the next call; do not print paths/errors.
      await budget.close({retainLock}).catch(()=>{});
    }
  };
}
export const executeCoach=createCoachExecutor();
