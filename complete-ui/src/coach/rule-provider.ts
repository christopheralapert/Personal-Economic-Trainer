import {sourceDate} from "@/engine/source-date";
import {z} from "zod";
import {type CoachMessage,createComponentTools} from "./catalog";
import {requestForIntent} from "./intent";
import {resolveQuestion} from "./resolve-question";
import {answerBasis,answerFromTool} from "./answer";
import {UnavailableScenarioError} from "@/engine";
import {translate} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";
import {throwIfCancelled,type CoachExecution} from "./execution";

export interface ChatProvider {answer(question:string,locale:Locale,savingsPercent:number,execution?:CoachExecution):Promise<CoachMessage>}
export class RuleProvider implements ChatProvider {
  async answer(question:string,locale:Locale,savingsPercent=10,execution:CoachExecution={}):Promise<CoachMessage> {
    throwIfCancelled(execution.signal);
    const t=(key:Parameters<typeof translate>[1])=>translate(locale,key);
    const message=(text:string):CoachMessage=>({id:crypto.randomUUID(),role:"assistant",parts:[{type:"text",text}]});
    const intent=resolveQuestion(question,execution.context,execution.period,execution.data ? sourceDate(execution.data.as_of) : undefined);
    if(intent.status!=="ready") return message(t(intent.reason.startsWith("FOLLOW_UP_") ? "followupHelp" : intent.reason==="MONTH_REQUIRED" ? "monthRequired" : intent.reason==="AMBIGUOUS_CATEGORY" ? "categoryRequired" : intent.status==="clarification_required" ? "ambiguous" : "unknown"));
    const {name,input}=requestForIntent(intent),tool=createComponentTools(savingsPercent,execution.data)[name];
    const parsed=(tool.inputSchema as z.ZodType<Record<string,unknown>>).safeParse(input);
    if(!parsed.success) return message(t("ambiguous"));
    let output:unknown;
    try {output=await (tool.execute as (value:unknown,options:unknown)=>Promise<unknown>)(parsed.data,{toolCallId:crypto.randomUUID(),messages:[]});}
    catch(error) {
      throwIfCancelled(execution.signal);
      if(error instanceof UnavailableScenarioError) return message(t("notAvailable")+". "+answerBasis(input,locale)+" "+t("partial"));
      throw error;
    }
    throwIfCancelled(execution.signal);
    return answerFromTool(name,parsed.data,output,locale);
  }
}
