"use client";
import {memo} from "react";
import {useCopy} from "@/i18n/context";
import type {CoachMessage,ToolName} from "@/coach/catalog";
import {followUps} from "@/coach/follow-ups";
import {ViewScope} from "@/lib/view-state";
import {resultViewName,type ViewStore} from "@/lib/view-store";
import {GeneratedComponent} from "./gen/registry";
import {Button} from "./ui/button";
import {useMoneyData} from "@/lib/money-data-context";
import {sourceDate} from "@/engine/source-date";
import {usePlanning} from "@/lib/planning-context";
import {monthRecovery} from "@/coach/month-recovery";
import {AnswerMonthChoice} from "./answer-month-choice";
/** Stable message objects and callbacks keep previous answers out of streaming render updates. */
export const ConversationEntry=memo(function ConversationEntry({message,question="",store,onAsk,onGoal,latest,busy}:{message:CoachMessage;question?:string;store:ViewStore;onAsk:(question:string)=>void;onGoal:()=>void;latest:boolean;busy:boolean}) {
 const {data}=useMoneyData(),{t}=useCopy(),{period}=usePlanning(),hasResult=message.parts.some(part=>part.type.startsWith("tool-") && "state" in part && part.state==="output-available"),recovery=latest && !busy && message.role==="assistant" ? monthRecovery(message,question,period,sourceDate(data.as_of)) : null;
 return <article data-message-id={message.id} data-message-role={message.role} className={message.role==="user" ? "ml-8 rounded-bubble rounded-br-sm bg-brand p-4 text-brand-ink" : "message-arrival scroll-mt-4 space-y-5 border-b border-line pb-6"}>
  {message.parts.filter(part=>part.type!=="text" || message.role!=="assistant" || (!hasResult && !recovery)).map((part,i)=>part.type==="text" ? <p key={i} className="min-w-0 wrap-anywhere text-base leading-relaxed">{part.text}</p> : part.type.startsWith("tool-") && "state" in part && part.state==="output-available" && "output" in part && "toolCallId" in part ? <ViewScope key={part.toolCallId} store={store} name={resultViewName(message.id,part.toolCallId)}><GeneratedComponent name={part.type.slice(5) as ToolName} output={part.output} onAsk={onAsk} onGoal={onGoal}/></ViewScope> : null)}
  {recovery && <AnswerMonthChoice context={recovery} onAsk={onAsk} busy={busy}/>}
  {!recovery && latest && message.role==="assistant" && <div className="scrollbar-none flex gap-2 overflow-x-auto">{followUps([message]).map(key=><Button key={key} variant="outline" size="chip" className="shrink-0" onClick={()=>onAsk(t(key))} disabled={busy}>{t(key)}</Button>)}</div>}
 </article>;
});
