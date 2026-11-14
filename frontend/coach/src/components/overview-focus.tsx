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
import {percent,money,date} from "@/lib/format";
import {billsAhead} from "@/engine/outlook";
import {BasisChip} from "./basis-chip";
import {TickBar} from "./gen/tick-bar";
import {DonutBreakdown} from "./gen/donut-breakdown";
import {SafeToSpendCard} from "./gen/safe-to-spend-card";
import {AskHome} from "./ask-home";
import {ReviewQueue} from "./review-queue";
import {Button} from "./ui/button";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "./ui/drawer";
export function BillsAhead() {
 const {data}=useMoneyData(),{t}=useCopy(),bills=billsAhead(data);
 return <section className="space-y-2"><h3 className="font-semibold">{t("billsAhead")}</h3><p className="text-caption text-ink-2">{t(bills.length ? "estimatedBill" : "noBillsDetected")}</p><ul className="divide-y divide-line">{bills.map(bill=><li key={`${bill.merchant}/${bill.due}`} className="flex min-h-14 items-center justify-between gap-3"><span>{bill.merchant}<span className="block text-caption text-ink-2">{date(bill.due)}</span></span><span>{money(bill.amount)}</span></li>)}</ul></section>;
}
function CompactPeriod() {
 const {data}=useMoneyData(),snapshot=sourceDate(data.as_of);
 const {period,setPeriod}=usePlanning(),{t,locale}=useCopy(),current=monthPeriod(snapshot),end=new Date(snapshot+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);const soFar={start:current.start,end:end.toISOString().slice(0,10)};
 return <section data-overview-block="period" className="grid grid-cols-transaction items-center gap-x-3"><Button variant="ghost" size="icon" aria-label={t("previousPeriod")} onClick={()=>setPeriod(monthPeriod(period.start,-1))}><ChevronLeft className="size-5"/></Button><p className="min-w-0 text-center text-sm font-semibold">{new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"))}</p><Button variant="ghost" size="icon" aria-label={t("nextPeriod")} disabled={period.start>=current.start} onClick={()=>{const next=monthPeriod(period.start,1);setPeriod(next.start===current.start ? soFar : next);}}><ChevronRight className="size-5"/></Button>{period.start!==current.start && <Button variant="ghost" size="chip" className="col-span-3 max-w-full gap-1 px-0 text-caption font-normal text-ink-2" aria-label={t("switchCurrent",{month:new Intl.DateTimeFormat(locale,{month:"long",timeZone:"UTC"}).format(new Date(snapshot+"T12:00:00Z"))})} onClick={()=>setPeriod(soFar)}><span>{t("latestFullMonth")}</span><span aria-hidden="true"> · </span><span className="text-brand">{t("currentMonthChip")}</span></Button>}</section>;
}

function SpendingHero() {
 const {data,queue,scope}=useMoneyData(),planning=usePlanning(),{t,savings}=useCopy(),[why,setWhy]=useState(false),income=overviewIncome(planning.period,data,planning.income),range=weeklyRange({data,income:planning.income,savingsPercent:savings,billsConfirmed:planning.billsConfirmed,classificationsReviewed:queue.length===0}),restricted=scope.excludedAccounts.length>0||scope.excludedCategories.length>0;
 const snapshot=sourceDate(data.as_of);
 const edit=()=>{setWhy(false);planning.openIncome();};
 return <section data-overview-block="hero" className="space-y-1"><h2 className="text-sm text-ink-2">{t("weekHero")}</h2><p className="text-3xl font-bold tabular-nums">{range.low!==null && range.high!==null && range.high>0 ? t("heroRange",{low:wholeNumber(range.low),high:wholeNumber(range.high)}) : t("needsInput")}</p><p className="text-sm text-ink-2">{t("heroNote")}</p>{income.source!=="recorded" && <button className="min-h-touch text-left text-sm text-ink-2" onClick={planning.openIncome} aria-label={t(income.needsInput ? "incomeMissing" : "incomeEdit")}>{income.needsInput ? t("incomeMissing") : <>{t("incomeApprox",{amount:wholeMoney(income.amount!)})} · <span className="text-brand underline">{t("estimateEdit")}</span></>}</button>}<div className="flex items-center justify-between gap-1"><BasisChip period={{start:monthPeriod(snapshot,-3).start,end:monthPeriod(snapshot).start}} label={t(range.confidence==="low" ? "confidenceLow" : "confidenceMedium")} confidence/><Drawer open={why} onOpenChange={setWhy}><DrawerTrigger asChild><Button variant="link" size="chip" className="text-sm">{t("why")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("calculation")}</DrawerTitle><DrawerDescription>{t(restricted ? "scopeReserveNote" : "heroNote")}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-6 overflow-y-auto px-4"><SafeToSpendCard result={safeToSpend(snapshot,data,savings)} calculationOnly/><BillsAhead/><Button variant="outline" onClick={edit}>{t("incomeEdit")}</Button></div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer></div></section>;
}
export function OverviewFocus({onAsk,onLearn,busy}:{onAsk:(question:string)=>void;onLearn:(basket:Basket)=>void;busy:boolean}) {
 const {data,queue}=useMoneyData(),{period}=usePlanning(),{t}=useCopy(),baskets=spendByBasket(period,data).sort((a,b)=>["mandatory_regular","mandatory_irregular","everyday","unresolved"].indexOf(a.key)-["mandatory_regular","mandatory_irregular","everyday","unresolved"].indexOf(b.key)),gross=exactSum(baskets.map(group=>group.gross));
 return <div className="overview-flow"><CompactPeriod/><SpendingHero/><section data-overview-block="categories"><DonutBreakdown key={`${period.start}/${period.end}`} compact alwaysRing groups={spendByCategory(period,data)} stateKey={`overview/${period.start}/${period.end}`} period={period} onAsk={onAsk}/></section><section data-overview-block="baskets" className="space-y-1"><TickBar parts={baskets.map(group=>({value:group.gross,className:group.key==="mandatory_regular" ? "bg-brand" : group.key==="mandatory_irregular" ? "bg-ink" : "bg-ink-2"}))} caption="" captionTone="ink"/><div className="flex flex-wrap items-center gap-x-2 text-caption">{baskets.filter(group=>group.gross>0).map(group=><button key={group.key} className="min-h-touch text-ink" onClick={()=>onLearn(group.key as Basket)}>{t(group.key==="mandatory_regular" ? "regularShort" : group.key==="mandatory_irregular" ? "surprisesShort" : group.key==="everyday" ? "everydayShort" : "unclassifiedShort")} {percent(gross>0 ? group.gross/gross*100 : 0).replace(/\s/gu,"")}</button>)}</div></section><div data-overview-block="ask"><AskHome onAsk={onAsk} busy={busy} trailing={queue.length ? <ReviewQueue/> : undefined}/></div></div>;
}
