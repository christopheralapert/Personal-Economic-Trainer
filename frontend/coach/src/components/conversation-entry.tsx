"use client";
import {memo,useRef} from "react";
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
import {ReadAloud} from "./speech-controls";
import {spokenAnswer} from "@/coach/spoken-answer";
import {useSpokenResult} from "@/lib/use-spoken-result";
import {answerLanguage,type ConversationLanguage} from '@/coach/conversation-language';
function SpeechSentence({name,input,output,locale}:{name:ToolName;input:unknown;output:unknown;locale:ConversationLanguage}){
 const current=useSpokenResult(name,input,output);
 if(!current?.speakable)return null;
 let sentence:string;try{sentence=spokenAnswer(name,current.input,current.output,locale);}catch{return null;}
 return <p data-spoken-answer className="text-base leading-relaxed text-ink">{sentence}</p>;
}
function ResultReply({name,input,output,text}:{name:ToolName;input:unknown;output:unknown;text:string}){
 const current=useSpokenResult(name,input,output);
 // The narrative describes the submitted selectors, not later slider/filter edits.
 // Once edited, the chart's live server-derived summary remains the source of truth.
 if(current && JSON.stringify(current.input)!==JSON.stringify(input))return null;
 return <p data-model-guidance data-conversation-reply className="min-w-0 whitespace-pre-wrap wrap-anywhere text-base leading-relaxed">{text}</p>;
}
/** Stable message objects and callbacks keep previous answers out of streaming render updates. */
export const ConversationEntry=memo(function ConversationEntry({message,question="",store,onAsk,onGoal,latest,busy}:{message:CoachMessage;question?:string;store:ViewStore;onAsk:(question:string)=>void;onGoal:()=>void;latest:boolean;busy:boolean}) {
 const {data}=useMoneyData(),{t,locale}=useCopy(),{period}=usePlanning(),hasResult=message.parts.some(part=>part.type.startsWith("tool-") && "state" in part && part.state==="output-available"),recovery=latest && !busy && message.role==="assistant" ? monthRecovery(message,question,period,sourceDate(data.as_of)) : null;
 const article=useRef<HTMLElement|null>(null),mode=message.metadata && typeof message.metadata==="object" && "answerMode" in message.metadata ? message.metadata.answerMode : undefined;
 const generatedGuidance=mode==='model' && message.metadata && typeof message.metadata==='object' && 'generatedGuidance' in message.metadata && message.metadata.generatedGuidance===true;
 const conversational=mode==='model' && message.metadata && typeof message.metadata==='object' && 'generatedConversation' in message.metadata && message.metadata.generatedConversation===true;
 const speechPart=message.parts.find(part=>part.type.startsWith("tool-") && "state" in part && part.state==="output-available" && "toolCallId" in part);
 return <article ref={article} data-message-id={message.id} data-message-role={message.role} className={message.role==="user" ? "ml-auto w-fit max-w-xs rounded-bubble rounded-br-sm bg-brand px-4 py-3 text-brand-ink" : "message-arrival scroll-mt-4 space-y-4 border-b border-line pb-6"}>
  {message.parts.filter((part,index)=>part.type!=="text" || message.role!=="assistant" || conversational || (!hasResult && !recovery) || (generatedGuidance && index===message.parts.length-1)).map((part,i)=>part.type==="text" ? conversational && speechPart && 'toolCallId' in speechPart && 'input' in speechPart && 'output' in speechPart ? <ViewScope key={`reply-${i}`} store={store} name={resultViewName(message.id,speechPart.toolCallId)}><ResultReply name={speechPart.type.slice(5) as ToolName} input={speechPart.input} output={speechPart.output} text={part.text}/></ViewScope> : <p key={i} data-model-guidance={generatedGuidance || conversational ? '' : undefined} data-conversation-reply={conversational ? '' : undefined} data-spoken-answer={message.role==="assistant" && !hasResult ? "" : undefined} className="min-w-0 whitespace-pre-wrap wrap-anywhere text-base leading-relaxed">{part.text}</p> : part.type.startsWith("tool-") && "state" in part && part.state==="output-available" && "output" in part && "toolCallId" in part ? <ViewScope key={part.toolCallId} store={store} name={resultViewName(message.id,part.toolCallId)}><GeneratedComponent name={part.type.slice(5) as ToolName} output={part.output} onAsk={onAsk} onGoal={onGoal} sentence={"input" in part ? <SpeechSentence name={part.type.slice(5) as ToolName} input={part.input} output={part.output} locale={answerLanguage(message.metadata,locale)}/> : undefined}/></ViewScope> : null)}
  {recovery && <AnswerMonthChoice context={recovery} onAsk={onAsk} busy={busy}/>}
  {message.role==="assistant" && !busy && <div className="flex flex-wrap items-center justify-between gap-x-3">{mode ? <p className="text-caption text-ink-2">{mode==="model" ? t("modeModel") : t("modeRules")}</p> : <span/>}<ViewScope store={store} name={speechPart && "toolCallId" in speechPart ? resultViewName(message.id,speechPart.toolCallId) : resultViewName(message.id,"speech")}><ReadAloud article={article} message={message}/></ViewScope></div>}
  {!recovery && latest && message.role==="assistant" && <div className="scrollbar-none flex gap-2 overflow-x-auto">{followUps([message]).map(key=><Button key={key} variant="outline" size="chip" className="shrink-0" onClick={()=>onAsk(t(key))} disabled={busy}>{t(key)}</Button>)}</div>}
 </article>;
});
