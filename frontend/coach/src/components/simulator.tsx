"use client";
import {useMemo,useRef,useState} from "react";
import {CalendarX2} from "lucide-react";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {useCopy,categoryLabel} from "@/i18n/context";
import {isCalendarMonth,monthPeriod,simulateReduction} from "@/engine";
import {combinedScenario,goalScenarioMonths} from "@/engine/scenario";
import {purchaseEquivalent} from "@/lib/monthly-plan";
import {money,percent,precisePercent} from "@/lib/format";
import {useViewState} from "@/lib/view-state";
import type {SavingsGoal} from "@/lib/savings-goal";
import {PeriodPager} from "./period-pager";
import {BasisChip} from "./basis-chip";
import {MonthlyPlanSheet} from "./monthly-plans";
import {CategorySwatch} from "./gen/category-icon";
import {Button} from "./ui/button";
import {Slider} from "./ui/slider";
import {EmptyState} from "./ui/empty-state";
const empty=Object.freeze({}) as Record<string,number>;
const defaultPct=20;
const selectedChip="border-brand bg-brand-tint text-active-ink dark:bg-brand-tint dark:hover:bg-brand-tint";

/**
 * One card: combined result on top, presets, a category picker built from the user's eligible categories, and one
 * slider for the picked category. Each category keeps its own percentage; the period comes from the shared pager.
 */
export function Simulator({goal=null}:{goal?:SavingsGoal|null}) {
 const {data}=useMoneyData(),{period,setPeriod}=usePlanning(),{t}=useCopy(),[values,setValues]=useViewState<Record<string,Record<string,number>>>("percentages",{}),[picked,setPicked]=useViewState<string|null>("picked",null),[creating,setCreating]=useState(false),slider=useRef<HTMLDivElement>(null);
 const percentages=values[period.start]??empty,result=useMemo(()=>isCalendarMonth(period) ? combinedScenario(period,percentages,data) : {categories:[],reductions:[],monthly:null,annual:null,incomeShare:null},[period,percentages,data]);
 const equivalent=useMemo(()=>purchaseEquivalent(result.monthly,period,data),[result.monthly,period,data]),goalMonths=goal ? goalScenarioMonths(goal.amountMinor,result.monthly) : null;
 const pctOf=(key:string)=>Object.hasOwn(percentages,key) ? percentages[key] : defaultPct;
 const current=result.categories.find(group=>group.key===picked)?.key ?? result.categories[0]?.key ?? null;
 const presets=[10,20,30],allSame=result.categories.length>0 && result.categories.every(group=>pctOf(group.key)===pctOf(result.categories[0].key)),activePreset=allSame ? pctOf(result.categories[0].key) : null;
 function preset(value:number){setValues(previous=>({...previous,[period.start]:Object.fromEntries(result.categories.map(group=>[group.key,value]))}));}
 function setPct(key:string,value:number){setValues(previous=>({...previous,[period.start]:{...previous[period.start],[key]:value}}));}
 const baseline=current ? simulateReduction(current,pctOf(current),period,data) : null;
 return <div className="space-y-4">
  <h2 className="text-xl font-semibold">{t("whatif")}</h2>
  <PeriodPager period={period} onChange={setPeriod}/>
  {result.monthly===null ? <EmptyState icon={CalendarX2} title={t(isCalendarMonth(period) ? "emptyRecords" : "monthRequired")} action={<Button variant="outline" onClick={()=>setPeriod(monthPeriod(period.start,-1))}>{t("previousPeriod")}</Button>}/> : <section aria-label={t("combined")} className="space-y-5 rounded-3xl border border-line bg-surface p-4">
   <dl className="space-y-1" aria-live="polite"><dt className="text-sm text-ink-2">{t("perMonth")}</dt><dd className="wrap-anywhere text-3xl font-semibold tabular-nums">{money(result.monthly)}</dd>
    <dd className="text-sm tabular-nums text-ink-2">{t("perYear")}: <span className="font-semibold text-ink">{money(result.annual!)}</span></dd>
    {equivalent && <dd className="text-sm text-ink-2">{t("purchaseEquivalent",{count:equivalent.count,category:categoryLabel(equivalent.category,t)})}</dd>}</dl>
   <div className="flex flex-wrap gap-2" role="group" aria-label={t("reduce")}>{presets.map(value=><Button key={value} variant="outline" size="chip" className={activePreset===value ? selectedChip : ""} aria-pressed={activePreset===value} aria-label={value===defaultPct ? t("resetScenario") : percent(value)} onClick={()=>preset(value)}>{percent(value)}</Button>)}<Button variant="outline" size="chip" className={activePreset===null || !presets.includes(activePreset) ? selectedChip : ""} aria-pressed={activePreset===null || !presets.includes(activePreset)} onClick={()=>slider.current?.querySelector<HTMLElement>('[role="slider"]')?.focus()}>{t("custom")}</Button></div>
   <div className="scrollbar-none -mx-4 flex gap-2 overflow-x-auto px-4" role="group" aria-label={t("category")}>{result.categories.map(group=><Button key={group.key} variant="outline" size="chip" aria-pressed={group.key===current} className={`shrink-0 gap-2 ${group.key===current ? selectedChip : ""}`} onClick={()=>setPicked(group.key)}><CategorySwatch category={group.key}/>{categoryLabel(group.key,t)} · {precisePercent(pctOf(group.key))}</Button>)}</div>
   {current && baseline && <div ref={slider} className="space-y-2"><div className="flex items-baseline justify-between gap-3 text-sm"><span className="text-ink-2">{t("baseline")}: {money(baseline.baseline)}</span><span className="font-semibold tabular-nums">−{money(baseline.monthly)}</span></div>
    <Slider aria-label={`${t("reduce")} ${categoryLabel(current,t)}`} aria-valuetext={precisePercent(pctOf(current))} className="min-h-12" min={0} max={100} step={1} value={[pctOf(current)]} onValueChange={([next])=>setPct(current,next)}/></div>}
   {result.monthly>0 && <Button className="h-auto min-h-12 w-full" onClick={()=>setCreating(true)}>{t("setAside",{amount:money(result.monthly)})}</Button>}
  </section>}
  {goal && <section className="space-y-2 rounded-2xl border border-line bg-surface p-4"><h3 className="wrap-anywhere font-semibold">{t("goalSummary",{name:goal.name,amount:money(goal.amountMinor)})}</h3><p role="status" className="text-sm">{goalMonths===null ? t("goalScenarioUnavailable") : t("goalScenarioMonths",{months:goalMonths})}</p><p className="text-caption text-ink-2">{t("goalScenarioNote")}</p></section>}
  <div className="space-y-1"><p className="text-caption text-ink-2">{t("assumption")}</p><BasisChip period={period}/></div>
  {creating && result.monthly!==null && result.monthly>0 && <MonthlyPlanSheet amount={result.monthly} onClose={()=>setCreating(false)}/>}
 </div>;
}
