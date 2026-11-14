"use client";
import {useEffect,useState} from "react";
import {ChevronRight} from "lucide-react";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {useCopy,type Key} from "@/i18n/context";
import {spendByBasket,exactSum} from "@/engine";
import {money,percent} from "@/lib/format";
import {transactionQuestion} from "@/coach/explore-question";
import {BasisChip} from "./basis-chip";
const topics=[{concept:"regular",basket:"mandatory_regular",question:"qBaskets"},{concept:"irregular",basket:"mandatory_irregular",question:"qBaskets"},{concept:"everyday",basket:"everyday",question:"qBaskets"},{concept:"fund",basket:"mandatory_irregular",question:"qSafe"},{concept:"savingConcept",basket:null,question:"qSave"},{concept:"habit",basket:"everyday",question:"qWhatif"}] as const;
const storageKey="money-coach-learning.v1";
export function PersonalizedLearn({onAsk}:{onAsk:(question:string)=>void}) {
 const {data}=useMoneyData(),{period,plans}=usePlanning(),{locale,t}=useCopy(),[read,setRead]=useState<string[]>([]);
 useEffect(()=>{try{const raw=localStorage.getItem(storageKey);if(raw && raw.length<2000){const value:unknown=JSON.parse(raw);if(Array.isArray(value))setRead(value.filter((key):key is string=>typeof key==="string" && topics.some(topic=>topic.concept===key)));}}catch{}},[]);
 const groups=spendByBasket(period,data),total=exactSum(groups.map(g=>g.gross));
 function open(topic:typeof topics[number]) {const next=[...new Set([...read,topic.concept])];setRead(next);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{}onAsk(topic.basket && ["regular","irregular","everyday"].includes(topic.concept) ? (transactionQuestion(period,{basket:topic.basket},locale)??t(topic.question)) : t(topic.question));}
 return <section className="space-y-3"><h2 className="text-xl font-bold">{t("learn")}</h2><p className="text-sm text-ink-2">{t("startHere")}</p><div className="divide-y divide-line">{topics.map(topic=>{
  const group=groups.find(g=>g.key===topic.basket),planned=topic.concept==="savingConcept" && plans.length ? exactSum(plans.map(p=>p.monthlyMinor)) : null;
  return <section id={`learn-${["regular","irregular","everyday"].includes(topic.concept) ? topic.basket : topic.concept}`} key={topic.concept} className="scroll-mt-6 py-4"><button className="flex min-h-14 w-full items-center gap-3 text-left" onClick={()=>open(topic)}><span className="min-w-0 flex-1 space-y-2"><span className="flex items-center gap-2 font-bold">{t(topic.concept==="regular" ? "regularBills" : topic.concept)}<span className={`size-2 shrink-0 rounded-full ${read.includes(topic.concept) ? "border border-ink-2" : "bg-brand"}`}><span className="sr-only">{t(read.includes(topic.concept) ? "readTopic" : "unreadTopic")}</span></span></span>{group && total>0 && <span className="block font-semibold">{t("yourBasketFact",{basket:t(topic.basket==="mandatory_regular" ? "regularBills" : topic.basket==="mandatory_irregular" ? "surpriseExpense" : "everyday"),amount:money(group.amount),share:percent(group.gross/total*100)})}</span>}{planned!==null && <span className="block font-semibold">{t("yourMonthlyPlanFact",{amount:money(planned)})}</span>}<span className="block text-sm leading-relaxed text-ink-2">{t(`${topic.concept}Text` as Key)}</span></span><ChevronRight className="size-5 shrink-0 text-brand"/></button></section>;
 })}</div><BasisChip period={period}/></section>;
}
