"use client";
import {useMemo,useRef,useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {useCopy,categoryLabel} from "@/i18n/context";
import {isCalendarMonth} from "@/engine";
import {combinedScenario,goalScenarioMonths} from "@/engine/scenario";
import {purchaseEquivalent} from "@/lib/monthly-plan";
import {money,percent} from "@/lib/format";
import {useViewState} from "@/lib/view-state";
import type {SavingsGoal} from "@/lib/savings-goal";
import {WhatIfSlider} from "./gen/what-if-slider";
import {PeriodPager} from "./period-pager";
import {BasisChip} from "./basis-chip";
import {MonthlyPlanSheet} from "./monthly-plans";
import {Button} from "./ui/button";
const empty=Object.freeze({}) as Record<string,number>;
export function Simulator({goal=null}:{goal?:SavingsGoal|null}) {
 const {data}=useMoneyData(),{period,setPeriod}=usePlanning(),{t}=useCopy(),[values,setValues]=useViewState<Record<string,Record<string,number>>>("percentages",{}),[creating,setCreating]=useState(false),controls=useRef<HTMLElement>(null);
 const percentages=values[period.start]??empty,result=useMemo(()=>isCalendarMonth(period) ? combinedScenario(period,percentages,data) : {categories:[],reductions:[],monthly:null,annual:null,incomeShare:null},[period,percentages,data]);
 const equivalent=useMemo(()=>purchaseEquivalent(result.monthly,period,data),[result.monthly,period,data]),goalMonths=goal ? goalScenarioMonths(goal.amountMinor,result.monthly) : null;
 function preset(value:number){setValues(previous=>({...previous,[period.start]:Object.fromEntries(result.categories.map(group=>[group.key,value]))}));}
 return <div className="space-y-4"><h2 className="text-xl font-bold">{t("whatif")}</h2><PeriodPager period={period} onChange={setPeriod}/>{result.monthly===null ? <p className="text-sm text-ink-2">{t(isCalendarMonth(period) ? "emptyRecords" : "monthRequired")}</p> : <section ref={controls} aria-label={t("combined")} className="space-y-4 rounded-3xl bg-tile-saving p-4"><dl className="grid grid-cols-2 gap-3" aria-live="polite"><div><dt className="text-caption text-ink-2">{t("perMonth")}</dt><dd className="wrap-anywhere text-3xl font-bold">{money(result.monthly)}</dd></div><div><dt className="text-caption text-ink-2">{t("perYear")}</dt><dd className="wrap-anywhere text-xl font-bold">{money(result.annual!)}</dd></div></dl><div className="flex flex-wrap gap-2">{[10,20,30].map(value=><Button key={value} variant="outline" size="chip" aria-label={value===20 ? t("resetScenario") : percent(value)} onClick={()=>preset(value)}>{percent(value)}</Button>)}<Button variant="ghost" size="chip" onClick={()=>controls.current?.querySelector<HTMLElement>('[role="slider"]')?.focus()}>{t("custom")}</Button></div>
 {result.categories.map(group=><WhatIfSlider compact key={`${period.start}/${group.key}`} category={group.key} period={period} value={Object.hasOwn(percentages,group.key) ? percentages[group.key] : 20} onPercentChange={pct=>setValues(previous=>({...previous,[period.start]:{...previous[period.start],[group.key]:pct}}))}/>)}
 {equivalent && <p className="text-sm text-ink-2">{t("purchaseEquivalent",{count:equivalent.count,category:categoryLabel(equivalent.category,t)})}</p>}{result.monthly>0 && <Button className="h-auto min-h-12 w-full" onClick={()=>setCreating(true)}>{t("setAside",{amount:money(result.monthly)})}</Button>}</section>}
 {goal && <section className="space-y-2 border-b border-line pb-4"><h3 className="wrap-anywhere font-semibold">{t("goalSummary",{name:goal.name,amount:money(goal.amountMinor)})}</h3><p role="status" className="text-sm">{goalMonths===null ? t("goalScenarioUnavailable") : t("goalScenarioMonths",{months:goalMonths})}</p><p className="text-caption text-ink-2">{t("goalScenarioNote")}</p></section>}
 <p className="text-caption text-ink-2">{t("assumption")}</p><BasisChip period={period} assumption/>{creating && result.monthly!==null && result.monthly>0 && <MonthlyPlanSheet amount={result.monthly} onClose={()=>setCreating(false)}/>}</div>;
}
