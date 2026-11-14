"use client";
import {useEffect,useState} from "react";
import {ChevronRight} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import type {components} from "@contracts";
import {flowCopy} from "../i18n/private-flow";
import {reviewCopy} from "../i18n/classification-review";
import {aborted,type PrivateRequest} from "./private-session";
import {lastMonth} from "./money-tools";
import {euros,sumMinor} from "./plan-format";

const topics=[{concept:"regular",basket:"mandatory_regular"},{concept:"irregular",basket:"mandatory_irregular"},{concept:"everyday",basket:"everyday"},{concept:"fund",basket:null},{concept:"savingConcept",basket:null}] as const;
export function PrivateLearn({request}:{request:PrivateRequest}){
 const {locale,t}=useCopy(),c=flowCopy[locale],r=reviewCopy[locale];
 const [period]=useState(lastMonth),[totals,setTotals]=useState<components["schemas"]["SpendingTotalsV1"]|null>(null),[error,setError]=useState(false);
 useEffect(()=>{let active=true;void request<components["schemas"]["SpendingToolResultV1"]>("analysis/tools/execute",{name:"spending_totals",arguments:{...period,currency:"EUR",account_ids:null,category:null,merchant:null,expected_data_version:null}}).then(value=>{if(active)setTotals(value.result);}).catch(reason=>{if(active&&!aborted(reason))setError(true);});return()=>{active=false;};},[request,period]);
 return <section className="space-y-3"><h1 className="text-xl font-bold">{t("learn")}</h1><p className="text-caption text-ink-2">{new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"))} · {c.partial}</p>{error&&<p role="alert" className="text-sm text-neg">{c.failed}</p>}<div className="divide-y divide-line">{topics.map(topic=>{const groups=topic.basket&&totals?totals.category_baskets.filter(g=>g.basket===topic.basket):[];const amount=groups.length?sumMinor(groups.map(g=>g.net_minor)):null;return <section id={topic.basket??topic.concept} key={topic.concept} className="scroll-mt-6 py-4"><h2 className="font-bold">{t(topic.concept)}</h2>{amount!==null&&totals!.expense_count>0&&<p className="mt-2 text-xl font-semibold">{euros(amount)}</p>}<p className="mt-2 text-sm leading-relaxed text-ink-2">{t(`${topic.concept}Text` as Key)}</p><a className="mt-2 flex min-h-12 items-center justify-between text-sm text-brand" href={`/transactions?start=${period.start}&end=${period.end_exclusive}`}>{c.records}<ChevronRight className="size-5"/></a></section>;})}</div>{totals&&totals.unresolved_flow_count>0&&<a href={`/transactions?start=${period.start}&end=${period.end_exclusive}&needs_review=true`} className="flex min-h-12 items-center justify-between text-sm text-brand">{r.review} ({totals.unresolved_flow_count})<ChevronRight className="size-5"/></a>}</section>;
}
