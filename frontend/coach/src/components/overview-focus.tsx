"use client";
import {sourceDate} from "@/engine/source-date";
import {useState} from "react";
import {ChevronLeft,ChevronRight} from "lucide-react";
import {useCopy} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {overviewIncome,wholeNumber,wholeMoney} from "@/lib/overview-model";
import {spendByBasket,spendByCategory,safeToSpend,monthPeriod,exactSum,type Basket} from "@/engine";
import {weeklyRange} from "@/engine/planning";
import {money,date} from "@/lib/format";
import {billsAhead} from "@/engine/outlook";
import {BasketSection} from "./gen/basket-section";
import {DonutBreakdown} from "./gen/donut-breakdown";
import {SafeToSpendCard} from "./gen/safe-to-spend-card";
import {AskHome} from "./ask-home";
import {ReviewQueue} from "./review-queue";
import {Button} from "./ui/button";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose,DrawerBody} from "./ui/drawer";
export function BillsAhead() {
 const {data}=useMoneyData(),{t}=useCopy(),bills=billsAhead(data);
 return <section className="space-y-2"><h3 className="font-semibold">{t("billsAhead")}</h3><p className="text-caption text-ink-2">{t(bills.length ? "estimatedBill" : "noBillsDetected")}</p><ul className="divide-y divide-line">{bills.map(bill=><li key={`${bill.merchant}/${bill.due}`} className="flex min-h-14 items-center justify-between gap-3"><span>{bill.merchant}<span className="block text-caption text-ink-2">{date(bill.due)}</span></span><span>{money(bill.amount)}</span></li>)}</ul></section>;
}
function CompactPeriod() {
 const {data}=useMoneyData(),snapshot=sourceDate(data.as_of);
 const {period,setPeriod}=usePlanning(),{t,locale}=useCopy(),current=monthPeriod(snapshot),end=new Date(snapshot+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);const soFar={start:current.start,end:end.toISOString().slice(0,10)};
 return <section data-overview-block="period" className="grid grid-cols-transaction items-center gap-x-3"><Button variant="ghost" size="icon" aria-label={t("previousPeriod")} onClick={()=>setPeriod(monthPeriod(period.start,-1))}><ChevronLeft className="size-5"/></Button><p className="min-w-0 text-center text-sm font-semibold">{new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"))}</p><Button variant="ghost" size="icon" aria-label={t("nextPeriod")} disabled={period.start>=current.start} onClick={()=>{const next=monthPeriod(period.start,1);setPeriod(next.start===current.start ? soFar : next);}}><ChevronRight className="size-5"/></Button>{period.start!==current.start && <Button variant="ghost" size="chip" className="col-span-3 max-w-full gap-1 px-0 text-caption font-normal text-ink-2" aria-label={t("switchCurrent",{month:new Intl.DateTimeFormat(locale,{month:"long",timeZone:"UTC"}).format(new Date(snapshot+"T12:00:00Z"))})} onClick={()=>setPeriod(soFar)}><span>{t("latestFullMonth")}</span><span aria-hidden="true"> · </span><span className="text-brand">{t("currentMonthChip")}</span></Button>}</section>;
}

function SpendingHero({spent,toCheck,month}:{spent:number;toCheck:number;month:string}) {
 const {data,queue,scope}=useMoneyData(),planning=usePlanning(),{t,savings}=useCopy(),[why,setWhy]=useState(false),income=overviewIncome(planning.period,data,planning.income),range=weeklyRange({data,income:planning.income,savingsPercent:savings,billsConfirmed:planning.billsConfirmed,classificationsReviewed:queue.length===0}),restricted=scope.excludedAccounts.length>0||scope.excludedCategories.length>0;
 const snapshot=sourceDate(data.as_of);
 const edit=()=>{setWhy(false);planning.openIncome();};
 if(range.low===null || range.high===null || range.high<=0) return <section data-overview-block="hero" className="flex flex-col items-start gap-1">
  <h2 className="text-sm text-ink-2">{t("spentIn",{month})}</h2>
  <p className="text-3xl font-semibold tabular-nums">{money(spent)}</p>
  <p className="text-sm text-ink-2">{t(income.needsInput ? "planningPrompt" : "spentInNote")}</p>
  <div className="pt-2">{income.needsInput || !toCheck ? <Button onClick={planning.openIncome}>{t("incomeMissing")}</Button> : <ReviewQueue variant="hero" period={planning.period} count={toCheck}/>}</div>
 </section>;
 return <section data-overview-block="hero" className="space-y-1">
  <h2 className="text-sm text-ink-2">{t("weekHero")}</h2>
  <p className="text-3xl font-semibold tabular-nums">{t("heroRange",{low:wholeNumber(range.low),high:wholeNumber(range.high)})}</p>
  <div className="flex min-h-touch items-center justify-between gap-3">
   <span className="flex items-center gap-2 text-sm text-ink-2"><span aria-hidden="true" className={`size-2 rounded-full ${range.confidence==="low" ? "bg-basket-surprises" : "bg-basket-regular"}`}/>{t(range.confidence==="low" ? "confidenceLow" : "confidenceMedium")}</span>
   <Drawer open={why} onOpenChange={setWhy}><DrawerTrigger asChild><Button variant="link" size="chip" className="px-0 text-sm">{t("why")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("calculation")}</DrawerTitle><DrawerDescription>{t(restricted ? "scopeReserveNote" : "heroNote")}</DrawerDescription></DrawerHeader><DrawerBody className="space-y-6"><p className="text-sm text-ink-2">{t("rangeBasis")} {t("based",{start:date(monthPeriod(snapshot,-3).start),end:date(new Date(Date.parse(monthPeriod(snapshot).start+"T12:00:00Z")-86400000).toISOString().slice(0,10))})}</p>{income.source!=="recorded" && !income.needsInput && <p className="text-sm">{t("incomeApprox",{amount:wholeMoney(income.amount!)})}</p>}<SafeToSpendCard result={safeToSpend(snapshot,data,savings)} calculationOnly/><BillsAhead/></DrawerBody><DrawerFooter><Button variant="outline" onClick={edit}>{t("incomeEdit")}</Button><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
  </div>
 </section>;
}
export function OverviewFocus({onAsk,onLearn,busy}:{onAsk:(question:string)=>void;onLearn:(basket:Basket)=>void;busy:boolean}) {
 const {data,queue}=useMoneyData(),{period}=usePlanning(),{locale}=useCopy(),baskets=spendByBasket(period,data),categories=spendByCategory(period,data);
 const spent=exactSum(categories.map(group=>group.amount)),toCheck=queue.filter(row=>row.booked_on>=period.start && row.booked_on<period.end).length;
 const month=new Intl.DateTimeFormat(locale,{month:"long",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"));
 const range=useHeroHasRange();
 return <div className="overview-flow"><CompactPeriod/><SpendingHero spent={spent} toCheck={toCheck} month={month}/>
  <section data-overview-block="categories"><DonutBreakdown key={`${period.start}/${period.end}`} compact alwaysRing showTotal={range} groups={categories} stateKey={`overview/${period.start}/${period.end}`} period={period} onAsk={onAsk}/></section>
  <section data-overview-block="baskets"><BasketSection values={baskets} toCheckCount={toCheck} reviewAction={<ReviewQueue period={period}/>} onBasket={key=>onLearn(key as Basket)}/></section>
  <div data-overview-block="ask"><AskHome onAsk={onAsk} busy={busy}/></div>
 </div>;
}
/** The donut shows the spent total only when the hero is not already showing it (every number once per screen). */
function useHeroHasRange() {
 const {data,queue}=useMoneyData(),planning=usePlanning(),{savings}=useCopy(),range=weeklyRange({data,income:planning.income,savingsPercent:savings,billsConfirmed:planning.billsConfirmed,classificationsReviewed:queue.length===0});
 return range.low!==null && range.high!==null && range.high>0;
}
