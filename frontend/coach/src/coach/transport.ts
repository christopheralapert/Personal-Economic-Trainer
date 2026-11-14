import {datasetKeySchema} from "@/engine/datasets";
import {dataScopeSchema} from "@/engine/data-scope";
import {periodSchema} from "@/engine";
import type {HttpChatTransportInitOptions} from "ai";
import type {CoachMessage} from "./catalog";

import {isFollowUpQuestion,questionContextSchema} from "./question-context";
import {languageCommand} from './conversation-language';

export const COACH_REVISION=process.env.NEXT_PUBLIC_MONEY_COACH_REVISION ?? "";
export const REVISION_HEADER="X-Money-Coach-Revision";

/** Only bounded dialogue text may accompany a hosted request; never send client tool output. */
export const prepareCoachRequest:NonNullable<HttpChatTransportInitOptions<CoachMessage>["prepareSendMessagesRequest"]>=({messages,body})=>{
  const latest=messages.at(-1);
  if(!latest || latest.role!=="user") throw new Error("A final user question is required");
  const question=latest.parts.filter(p=>p.type==="text").map(p=>p.text).join(" ");
  const context=isFollowUpQuestion(languageCommand(question)?.question||question) && body?.context!==undefined ? questionContextSchema.parse(body.context) : undefined;
  const history=body?.privacy===false?messages.slice(0,-1).filter(message=>message.role==='user'||message.role==='assistant').slice(-8).map(message=>({role:message.role,parts:message.parts.filter(part=>part.type==='text').map(part=>({type:'text' as const,text:part.text.slice(0,2000)})).slice(0,1)})):[];
  return {body:{...(body?.dataset===undefined ? {} : {dataset:datasetKeySchema.parse(body.dataset)}),...(body?.scope===undefined ? {} : {scope:dataScopeSchema.parse(body.scope)}),...(body?.period===undefined ? {} : {period:periodSchema.parse(body.period)}),...(context ? {context} : {}),messages:[...history,{role:latest.role,parts:latest.parts}],
    ...(body?.privacy===undefined ? {} : {privacy:body.privacy===true}),
    ...(body?.locale===undefined ? {} : {locale:body.locale}),
    ...(body?.conversationLanguage===undefined ? {} : {conversationLanguage:body.conversationLanguage}),
    ...(body?.savingsPercent===undefined ? {} : {savingsPercent:body.savingsPercent}),
  }};
};

/** Preserve native SDK messages; reject mixed-build figures before decoding SSE. */
export const coachFetch:typeof fetch=async(input,init)=>{
  if(!COACH_REVISION) throw new Error("Coach build identity unavailable");
  const headers=new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  headers.set(REVISION_HEADER,COACH_REVISION);
  const response=await fetch(input,{...init,headers,cache:"no-store"});
  if(response.ok && response.headers.get(REVISION_HEADER)!==COACH_REVISION) {
    void response.body?.cancel().catch(()=>{});
    throw new Error("Coach build changed");
  }
  return response;
};
