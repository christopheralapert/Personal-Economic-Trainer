"use client";
import {useEffect,useMemo,useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {useCopy,categoryLabel,type Key} from "@/i18n/context";
import {spendByBasket,exactSum,isCalendarMonth} from "@/engine";
import {combinedScenario} from "@/engine/scenario";
import {money,percent} from "@/lib/format";
import {transactionQuestion} from "@/coach/explore-question";
import {BasisChip} from "./basis-chip";
import {LearnTopics} from "./learn-topics";
import type {LearnConcept} from "@/i18n/learning";
const topics=[
 {concept:"regular",title:"regularShort",basket:"mandatory_regular",question:"qBaskets",dot:"bg-basket-regular"},
 {concept:"irregular",title:"surprisesShort",basket:"mandatory_irregular",question:"qBaskets",dot:"bg-basket-surprises"},
 {concept:"everyday",title:"everydayShort",basket:"everyday",question:"qBaskets",dot:"bg-basket-everyday"},
 {concept:"fund",title:"fund",basket:"mandatory_irregular",question:"qSafe",dot:null},
 {concept:"savingConcept",title:"savingConcept",basket:null,question:"qSave",dot:null},
 {concept:"habit",title:"habit",basket:"everyday",question:"qWhatif",dot:null},
] as const;
const storageKey="money-coach-learning.v1";
const basketTopic=(concept:string)=>["regular","irregular","everyday"].includes(concept);

/** Learn: every card opens with the user's own number, then the idea in one or two sentences; the row asks the Coach. */
export function PersonalizedLearn({onAsk}:{onAsk:(question:string)=>void}) {
 const {data}=useMoneyData(),{period,plans}=usePlanning(),{locale,t,savings}=useCopy(),[read,setRead]=useState<string[]>([]);
 useEffect(()=>{try{const raw=localStorage.getItem(storageKey);if(raw && raw.length<2000){const value:unknown=JSON.parse(raw);if(Array.isArray(value))setRead(value.filter((key):key is string=>typeof key==="string" && topics.some(topic=>topic.concept===key)));}}catch{}},[]);
 const groups=spendByBasket(period,data),total=exactSum(groups.map(g=>g.gross)),month=new Intl.DateTimeFormat(locale,{month:"long",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"));
 const flexible=useMemo(()=>{try{return isCalendarMonth(period) ? combinedScenario(period,{},data).categories[0] ?? null : null;}catch{return null;}},[period,data]);
 function fact(topic:typeof topics[number]):string|null {
  const group=groups.find(g=>g.key===topic.basket);
  if(basketTopic(topic.concept)) return group && total>0 ? t("learnBasketFact",{amount:money(group.amount),share:percent(group.gross/total*100),month}) : null;
  if(topic.concept==="fund") return group ? t("fundFact",{count:group.count,month}) : null;
  if(topic.concept==="savingConcept") return plans.length ? t("yourMonthlyPlanFact",{amount:money(exactSum(plans.map(p=>p.monthlyMinor)))}) : t("savingTargetFact",{share:percent(savings)});
  return flexible ? t("habitFact",{category:categoryLabel(flexible.key,t),amount:money(flexible.amount),month}) : null;
 }
 function markRead(concept:LearnConcept) {const next=[...new Set([...read,concept])];setRead(next);try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{}}
 function question(topic:typeof topics[number]) {
  if(topic.basket&&basketTopic(topic.concept))return transactionQuestion(period,{basket:topic.basket},locale)??t(topic.question);
  if(topic.concept==="habit"&&flexible){const through=new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10);return `${t("retryReduction",{category:JSON.stringify(flexible.key),pct:20})} ${t("queryPeriod",{start:period.start,end:through})}`;}
  return t(topic.question);
 }
 return <section className="space-y-4"><div className="space-y-1"><h2 className="text-xl font-semibold">{t("learn")}</h2><p className="text-sm text-ink-2">{t("startHere")}</p></div>
  <LearnTopics topics={topics.map(topic=>({id:`learn-${basketTopic(topic.concept)?topic.basket:topic.concept}`,concept:topic.concept,title:topic.title as Key,dot:topic.dot,fact:fact(topic),question:question(topic),...(topic.basket&&basketTopic(topic.concept)?{onRecords:()=>onAsk(question(topic))}:{})}))} read={read} onRead={markRead} onAsk={onAsk}/>
  <BasisChip period={period}/></section>;
}
