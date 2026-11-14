"use client";
import {useId,useState} from "react";
import {ChevronDown} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {learningCopy,type LearnConcept} from "@/i18n/learning";
import {Button} from "./ui/button";
export type LearnTopic={id:string;concept:LearnConcept;title:Key;dot?:string|null;fact?:string|null;question:string;recordsHref?:string;onRecords?:()=>void};

/** Shared educational content; private figures and reading state never enter browser storage. */
export function LearnTopics({topics,read,onRead,onAsk}:{topics:LearnTopic[];read:string[];onRead:(key:LearnConcept)=>void;onAsk:(question:string)=>void}){
 const {t,locale}=useCopy(),c=learningCopy[locale],id=useId(),[open,setOpen]=useState<LearnConcept|null>(null);
 return <><p className="text-caption text-ink-2" role="status">{c.progress.replace("{count}",String(topics.filter(topic=>read.includes(topic.concept)).length)).replace("{total}",String(topics.length))}</p>
 <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{topics.map(topic=>{
  const expanded=open===topic.concept,label=`${id}-${topic.concept}`,content=`${label}-content`;
  return <section id={topic.id} key={topic.concept} className="scroll-mt-6">
   <h3><button id={label} type="button" aria-expanded={expanded} aria-controls={content} className="flex min-h-14 w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-tile-grey focus-visible:bg-tile-grey" onClick={()=>{setOpen(expanded?null:topic.concept);if(!expanded)onRead(topic.concept);}}>
    <span className="min-w-0 flex-1 space-y-1"><span className="flex items-center gap-2 text-base font-semibold">{topic.dot&&<span className={`size-3 shrink-0 rounded-full ${topic.dot}`} aria-hidden="true"/>}{t(topic.title)}<span className={`size-2 shrink-0 rounded-full ${read.includes(topic.concept)?"border border-ink-2":"bg-brand"}`}><span className="sr-only">{t(read.includes(topic.concept)?"readTopic":"unreadTopic")}</span></span></span>
     {topic.fact&&<span className="block text-sm font-medium tabular-nums">{topic.fact}</span>}<span className="block text-sm font-normal leading-relaxed text-ink-2">{t(`${topic.concept}Text` as Key)}</span>
    </span><ChevronDown aria-hidden="true" className={`size-5 shrink-0 text-ink-2 transition-transform motion-reduce:transition-none ${expanded?"rotate-180":""}`}/>
   </button></h3>
   <div id={content} role="region" aria-labelledby={label} hidden={!expanded} className="space-y-4 px-4 pb-5">
    <p className="text-sm leading-relaxed text-ink-2">{c[topic.concept].body}</p><div className="space-y-1"><h4 className="text-sm font-semibold">{c.next}</h4><p className="text-sm leading-relaxed text-ink-2">{c[topic.concept].step}</p></div>
    <div className="flex flex-wrap gap-2"><Button variant="outline" size="chip" onClick={()=>onAsk(topic.question)}>{t("askCoach")}</Button>{topic.recordsHref?<Button asChild variant="ghost" size="chip"><a href={topic.recordsHref}>{c.records}</a></Button>:topic.onRecords?<Button variant="ghost" size="chip" onClick={topic.onRecords}>{c.records}</Button>:null}</div>
   </div>
  </section>;
 })}</div></>;
}
