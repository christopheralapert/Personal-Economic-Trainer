"use client";
import {useMoneyData} from "@/lib/money-data-context";
import {BasisChip} from "../basis-chip";
import {useMemo} from "react";
import {useViewState} from "@/lib/view-state";
import type {z} from "zod";
import {propsSchemas,type ToolName} from "@/coach/catalog";
import {spokenAnswer} from "@/coach/spoken-answer";
import {useCopy,categoryLabel,basketLabel} from "@/i18n/context";
import {spendByCategory,simulateReduction,transactionHistory,monthPeriod,exactSum,type TransactionFilters} from "@/engine";
import {money} from "@/lib/format";
import {DonutBreakdown} from "./donut-breakdown";
import {SummaryTiles} from "./summary-tiles";
import {TickBar} from "./tick-bar";
import {BasketCard} from "./basket-card";
import {CategoryList} from "./category-list";
import {HistoryResult,useHistorySnapshot} from "./history-result";
import {transactionPage} from "@/engine/history";
import {SafeToSpendCard} from "./safe-to-spend-card";
import {WhatIfSlider} from "./what-if-slider";
import {SpenderProfile} from "./spender-profile";
import {BenchmarkBars} from "./benchmark-bars";
import {PeerBars} from "./peer-bars";
import {ConceptCard} from "./concept-card";
import {InfoBanner} from "./info-banner";
import {searchTransactions} from "@/lib/transaction-view";
import {TransactionList} from "./transaction-list";
import {Input} from "@/components/ui/input";
import {PeriodSheet} from "./period-sheet";
import {FilterSheet} from "./filter-sheet";
import {StepperHeader} from "./stepper-header";
import {Button} from "@/components/ui/button";

type Ask={onAsk?:(question:string)=>void};
type Sentence={sentence?:React.ReactNode};
function ScopeSummary({filters}:{filters:TransactionFilters}) {
  const {t}=useCopy();
  return filters.basket!==undefined || filters.category!==undefined || filters.merchant!==undefined ? <dl className="space-y-2 text-caption text-ink-2">{filters.basket!==undefined && <div className="flex flex-wrap gap-2"><dt>{t("basket")}:</dt><dd className="min-w-0 wrap-anywhere">{basketLabel(filters.basket,t)}</dd></div>}{filters.category!==undefined && <div className="flex flex-wrap gap-2"><dt>{t("category")}:</dt><dd className="min-w-0 wrap-anywhere">{categoryLabel(filters.category,t)}</dd></div>}{filters.merchant!==undefined && <div className="flex flex-wrap gap-2"><dt>{t("merchant")}:</dt><dd className="min-w-0 wrap-anywhere">{filters.merchant}</dd></div>}</dl> : <p className="text-caption text-ink-2">{t("scopeAll")}</p>;
}
function TransactionsAnswer({period,filters,onAsk,...initial}:z.infer<typeof propsSchemas.showTransactions>&Ask) {
  const {t,locale}=useCopy(),history=useHistorySnapshot(initial);

  const description=spokenAnswer("showTransactions",{period,...filters},{...history,period,filters},locale);
  return <section className="space-y-4"><div className="space-y-2">{history.netExpenses!==null && <p className="text-3xl font-semibold tabular-nums">{money(history.netExpenses)}</p>}<p data-spoken-answer className="text-base leading-relaxed text-ink">{description}</p></div><ScopeSummary filters={filters}/><h3 className="font-semibold">{t("transactions")}</h3><HistoryResult initial={history} period={period} filters={filters} status="booked" onAsk={onAsk} openDetails/><BasisChip period={period} count={history.total}/></section>;
}
function PeriodAnswer({period:initial,groups,onAsk}:z.infer<typeof propsSchemas.showDetails>&Ask) {
  const {data}=useMoneyData(),[period,setPeriod]=useViewState("period",initial);

  const current=period.start===initial.start && period.end===initial.end ? groups : spendByCategory(period,data);
  return <div className="space-y-4"><CategoryList groups={current} period={period} onAsk={onAsk}/><PeriodSheet period={period} onChange={setPeriod}/><BasisChip period={period}/></div>;
}
function FilterAnswer({value:initial,period:initialPeriod,filters:initialFilters,onAsk,...initialPage}:z.infer<typeof propsSchemas.showFilter>&Ask) {
  const {data}=useMoneyData(),{t}=useCopy(),[value,setValue]=useViewState("status",initial),[period,setPeriod]=useViewState("historyPeriod",initialPeriod),[filters,setFilters]=useViewState("filters",initialFilters),[text,setText]=useViewState("historySearch","");
  const original=useHistorySnapshot(initialPage);
  const history=useMemo(()=>value===initial && period.start===initialPeriod.start && period.end===initialPeriod.end && filters.category===initialFilters.category && filters.merchant===initialFilters.merchant && filters.basket===initialFilters.basket ? original : transactionPage(period,value,data,filters),[period,value,filters,initial,initialPeriod,initialFilters,original,data]);
  const scopeKey=JSON.stringify([value,period.start,period.end,filters]),matched=useMemo(()=>text ? searchTransactions(transactionHistory(period,value,data,filters),text,Object.fromEntries(data.transactions.map(row=>[row.category,categoryLabel(row.category,t)]))) : null,[text,period,value,data,filters,t]);
  return <section className="space-y-4"><h3 className="font-semibold">{t("transactions")}</h3><ScopeSummary filters={filters}/><label className="block space-y-2"><span>{t("searchTransactions")}</span><Input type="search" maxLength={120} value={text} onChange={event=>setText(event.target.value)}/></label>{text && <Button variant="outline" onClick={()=>setText("")}>{t("clearSearch")}</Button>}<div className="flex flex-wrap gap-3"><FilterSheet value={value} onChange={setValue}/>{(filters.basket!==undefined || filters.category!==undefined || filters.merchant!==undefined) && <Button variant="outline" className="h-auto min-h-12 max-w-full whitespace-normal" onClick={()=>setFilters({})}>{t("clearScope")}</Button>}</div><p role="status" className="text-caption text-ink-2">{t(value)} · {t("matchedTransactions",{count:matched?.length??history.total})}</p>{matched ? <TransactionList key={`${scopeKey}/${text}`} rows={matched} period={period} filters={filters} onAsk={onAsk}/> : <HistoryResult key={scopeKey} initial={history} period={period} filters={filters} status={value} onAsk={onAsk}/>}<PeriodSheet period={period} onChange={setPeriod}/><p className="text-caption text-ink-2">{t("historyNote")}</p><BasisChip period={period}/></section>;
}
function GoalAnswer({onGoal}:{onGoal?:()=>void}) {
  const {t}=useCopy();return <div className="space-y-4"><StepperHeader step={1}/><p className="text-sm text-ink-2">{t("goalLocal")}</p><Button onClick={onGoal} disabled={!onGoal}>{t("openGoal")}</Button></div>;
}

function DonutAnswer({period:initial,groups,onAsk,sentence}:z.infer<typeof propsSchemas.showDonut>&Ask&Sentence) {
  const {data}=useMoneyData(),[period,setPeriod]=useViewState("period",initial);

  const current=period.start===initial.start && period.end===initial.end ? groups : spendByCategory(period,data);
  // Headline first; the ring then omits its centre total so each number appears once.
  return <div className="space-y-4"><div className="space-y-1">{current.length>0&&<p className="text-3xl font-semibold tabular-nums">{money(exactSum(current.map(group=>group.amount)))}</p>}{sentence}</div><DonutBreakdown compact showTotal={false} key={`${period.start}/${period.end}`} groups={current} stateKey={`${period.start}/${period.end}`} period={period} onAsk={onAsk}/><div className="flex flex-wrap items-center gap-2"><BasisChip period={period}/><PeriodSheet period={period} onChange={setPeriod}/></div></div>;
}
function TicksAnswer({groups}:z.infer<typeof propsSchemas.showTicks>) {
  const {t}=useCopy(),tone:Record<string,string>={mandatory_regular:"bg-basket-regular",mandatory_irregular:"bg-basket-surprises",everyday:"bg-basket-everyday",unresolved:"bg-hatch"};
  return <TickBar parts={groups.map(g=>({value:g.gross,className:tone[g.key]??"bg-brand"}))} caption={t("gross")}/>;
}
function WhatIfAnswer({category,initialPct,period,sentence}:z.infer<typeof propsSchemas.showWhatIf>&Sentence){
  const {data}=useMoneyData(),[monthly,setMonthly]=useViewState("monthly",()=>simulateReduction(category,initialPct,period,data).monthly);

  return <div className="space-y-4"><div className="space-y-1"><p aria-live="polite" className="text-3xl font-semibold tabular-nums">{money(monthly)}</p>{sentence}</div><WhatIfSlider category={category} initialPct={initialPct} period={period} onChange={setMonthly} showResult={false}/><BasisChip period={period} assumption/></div>;
}
export const componentRegistry={
  peerComparison:PeerBars,
  showDonut:DonutAnswer,showSummary:SummaryTiles,
  showTicks:TicksAnswer,
  showBaskets:BasketCard,showCategories:CategoryList,showTransactions:TransactionsAnswer,
  showSafeToSpend:SafeToSpendCard,showWhatIf:WhatIfAnswer,showProfile:SpenderProfile,
  showBenchmark:BenchmarkBars,showConcept:ConceptCard,showInfo:InfoBanner,
  showDetails:PeriodAnswer,showFilter:FilterAnswer,showStepper:GoalAnswer,
};
/** Components that lead with their own headline number place the plain sentence directly under it. */
const headlineLed=new Set<ToolName>(["showDonut","showWhatIf"]);
export function GeneratedComponent({name,output,onAsk,onGoal,sentence}:{name:ToolName;output:unknown;onAsk?:(question:string)=>void;onGoal?:()=>void;sentence?:React.ReactNode}) {
  const checked=useMemo(()=>propsSchemas[name].safeParse(output),[name,output]),{t}=useCopy();
  if(!checked.success) return <p role="alert" className="text-sm text-ink-2">{t("unknown")}</p>;
  const Component=componentRegistry[name] as React.ComponentType<Record<string,unknown>>;
  const basis=name==="showSafeToSpend" ? monthPeriod(propsSchemas.showSafeToSpend.parse(checked.data).result.asOf) : "period" in checked.data ? checked.data.period as import("@/engine").Period : "result" in checked.data && typeof checked.data.result==="object" && checked.data.result!==null && "period" in checked.data.result ? checked.data.result.period as import("@/engine").Period : undefined;
  return <>{!headlineLed.has(name) && sentence}<Component {...checked.data} onAsk={onAsk} onGoal={onGoal} onClick={()=>onAsk?.(t("qSafe"))} {...(headlineLed.has(name) ? {sentence} : {})}/>{!["showTransactions","showDonut","showWhatIf","showDetails","showFilter","peerComparison"].includes(name) && <BasisChip period={basis}/>}</>;
}
