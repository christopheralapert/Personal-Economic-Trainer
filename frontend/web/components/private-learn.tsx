"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {useEffect,useState} from "react";
import {useRouter} from "next/navigation";
import {ChevronLeft,ChevronRight} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {learningCopy,type LearnConcept} from "@/i18n/learning";
import {LearnTopics,type LearnTopic} from "@/components/learn-topics";
import {Button} from "@/components/ui/button";
import {Skeleton} from "@/components/ui/skeleton";
import {InlineError} from "@/components/ui/inline-error";
import type {components} from "@contracts";
import {flowCopy} from "../i18n/private-flow";
import {reviewCopy} from "../i18n/classification-review";
import {overviewCopy} from "../i18n/private-overview";
import {aborted,type PrivateRequest} from "./private-session";
import {useDashboard} from "./dashboard-workspace";
import {lastMonth} from "./money-tools";
import {euros,sumMinor} from "./plan-format";
const topics=[
 {concept:"regular",title:"regularShort",basket:"mandatory_regular",question:"qBaskets",dot:"bg-basket-regular"},
 {concept:"irregular",title:"surprisesShort",basket:"mandatory_irregular",question:"qBaskets",dot:"bg-basket-surprises"},
 {concept:"everyday",title:"everydayShort",basket:"everyday",question:"qBaskets",dot:"bg-basket-everyday"},
 {concept:"fund",title:"fund",basket:"mandatory_irregular",question:"qSafe",dot:null},
 {concept:"savingConcept",title:"savingConcept",basket:null,question:"qSave",dot:null},
 {concept:"habit",title:"habit",basket:"everyday",question:"qWhatif",dot:null},
] as const;
type Totals=components["schemas"]["SpendingTotalsV1"];
export function PrivateLearn({request}:{request:PrivateRequest}){
 const {locale,t}=useCopy(),c=flowCopy[copyLocale(locale)],r=reviewCopy[copyLocale(locale)],o=overviewCopy[copyLocale(locale)],router=useRouter();
 const {data,error:accountError,loading:accountsLoading,load}=useDashboard(request);
 const [period,setPeriod]=useState(lastMonth),[account,setAccount]=useState(""),[totals,setTotals]=useState<Totals|null>(null),[error,setError]=useState(false),[loading,setLoading]=useState(true),[retry,setRetry]=useState(0),[read,setRead]=useState<string[]>([]);
 const accounts=(data?.accounts??[]).filter(a=>a.included&&a.currency==="EUR"),validAccount=!account||accounts.some(a=>a.id===account);
 useEffect(()=>{let active=true;setTotals(null);setError(false);if(accountsLoading)return()=>{active=false;};if(!accounts.length||!validAccount){setLoading(false);return()=>{active=false;};}setLoading(true);
  void request<components["schemas"]["SpendingToolResultV1"]>("analysis/tools/execute",{name:"spending_totals",arguments:{...period,currency:"EUR",account_ids:account?[account]:null,category:null,merchant:null,expected_data_version:data!.data_version}}).then(value=>{if(active)setTotals(value.result);}).catch(reason=>{if(active&&!aborted(reason))setError(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};
 },[request,period,account,data,accountsLoading,retry,validAccount,accounts.length]);
 const month=new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"));
 const params=new URLSearchParams({start:period.start,end:period.end_exclusive});if(account)params.set("account_id",account);
 const history=`/transactions?${params}`,busy=loading||accountsLoading,failed=error||!!accountError||!validAccount;
 const current=totals?.scope.start===period.start&&totals.scope.end_exclusive===period.end_exclusive&&totals.scope.data_version===data?.data_version?totals:null;
 const basketTopic=(concept:string)=>["regular","irregular","everyday"].includes(concept);
 const through=new Date(Date.parse(period.end_exclusive+"T12:00:00Z")-86400000).toISOString().slice(0,10);
 const periodText=t("queryPeriod",{start:period.start,end:through});
 const flexible=current?.category_baskets.filter(g=>g.basket==="everyday"&&g.gross_minor>0).sort((a,b)=>b.gross_minor-a.gross_minor)[0];
 function move(offset:number){const date=new Date(period.start+"T12:00:00Z");date.setUTCMonth(date.getUTCMonth()+offset,1);const start=date.toISOString().slice(0,10);date.setUTCMonth(date.getUTCMonth()+1,1);setTotals(null);setPeriod({start,end_exclusive:date.toISOString().slice(0,10)});}
 const cards:LearnTopic[]=topics.map(topic=>{
  const groups=current?.category_baskets.filter(g=>g.basket===topic.basket)??[],amount=sumMinor(groups.map(g=>g.net_minor)),gross=sumMinor(groups.map(g=>g.gross_minor)),count=groups.reduce((sum,g)=>sum+g.transaction_count,0);
  const fact=!busy&&!failed&&current&&!current.category_breakdown_truncated&&current.gross_minor>0&&groups.length>0?(basketTopic(topic.concept)?t("learnBasketFact",{amount:euros(amount),share:new Intl.NumberFormat(locale,{style:"percent",maximumFractionDigits:0}).format(gross/current.gross_minor),month}):topic.concept==="fund"?t("fundFact",{count,month}):null):null;
  return {id:basketTopic(topic.concept)?topic.basket!:topic.concept,concept:topic.concept,title:topic.title as Key,dot:topic.dot,fact,question:basketTopic(topic.concept)?`${t("retrySpending")} ${periodText}`:topic.concept==="habit"?`${flexible?t("retryReduction",{category:JSON.stringify(flexible.label),pct:20}):t(topic.question)} ${periodText}`:t(topic.question),...(!busy&&!failed&&current?{recordsHref:history}:{})};
 });
 return <section className="space-y-4"><div className="space-y-1"><h1 className="text-xl font-semibold">{t("learn")}</h1><p className="text-sm text-ink-2">{t("startHere")}</p></div>
  <div className="flex items-center justify-between gap-3"><Button variant="ghost" size="icon" aria-label={o.previous} onClick={()=>move(-1)}><ChevronLeft className="size-5"/></Button><h2 className="text-sm font-semibold">{month}</h2><Button variant="ghost" size="icon" aria-label={o.next} disabled={period.start>=new Date().toISOString().slice(0,7)+"-01"} onClick={()=>move(1)}><ChevronRight className="size-5"/></Button></div>
  {accounts.length>1&&<label className="grid gap-1 text-sm">{t("accounts")}<select className="min-h-12 rounded-xl border border-line bg-surface px-3 text-ink" value={account} onChange={e=>{setTotals(null);setAccount(e.target.value);}}><option value="">{o.allAccounts}</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
  {busy&&<div role="status" className="space-y-2"><span className="sr-only">{c.loading}</span><Skeleton className="h-4 w-3/4"/><Skeleton className="h-4 w-1/2"/></div>}
  {failed&&<InlineError message={c.failed} onRetry={()=>{void load();setRetry(v=>v+1);}}/>}
  {!busy&&!failed&&(!current||current.gross_minor===0)&&<div className="space-y-2"><p className="text-sm text-ink-2">{learningCopy[locale].noFacts}</p><a className="inline-flex min-h-12 items-center text-sm text-active-ink underline" href={accounts.length?history:"/banks"}>{accounts.length?c.records:t("settingsBanks")}</a></div>}
  <LearnTopics topics={cards} read={read} onRead={(key:LearnConcept)=>setRead(values=>[...new Set([...values,key])])} onAsk={question=>router.push(`/coach?${params}&question=${encodeURIComponent(question)}`)}/>
  {current&&current.unresolved_flow_count>0&&<a href={`${history}&needs_review=true`} className="flex min-h-12 items-center justify-between text-sm text-active-ink">{r.review} ({current.unresolved_flow_count})<ChevronRight className="size-5"/></a>}
  <p className="text-caption text-ink-2">{month} · {c.partial} {learningCopy[locale].note}</p>
 </section>;
}
