"use client";
import {useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";

import {useCopy,type Key} from "@/i18n/context";
import {money,date,percent} from "@/lib/format";
import {usePlanning} from "@/lib/planning-context";
import {weeklyRange} from "@/engine/planning";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "@/components/ui/drawer";
import {Card,CardContent} from "@/components/ui/card";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {ReviewQueue} from "@/components/review-queue";
import type {safeToSpend,ReviewReason} from "@/engine";
const reasonCopy:Record<ReviewReason,Key>={history_incomplete:"incompleteHistory",schedule_unreviewed:"unreviewedSchedule",balances_missing:"missingBalances",income_missing:"noIncome",date_mismatch:"stale",balances_outdated:"outdatedBalances"};
export function SafeToSpendCard({result,purpose="spend",onGoal,calculationOnly=false}:{result:ReturnType<typeof safeToSpend>;purpose?:"spend"|"save";onGoal?:()=>void;calculationOnly?:boolean}) {
 const {data,queue,scope}=useMoneyData(),restricted=scope.excludedAccounts.length>0 || scope.excludedCategories.length>0,{t}=useCopy(),planning=usePlanning(),range=weeklyRange({data,income:planning.income,savingsPercent:result.savingsPercent,billsConfirmed:planning.billsConfirmed,classificationsReviewed:queue.length===0});
 const compatible=(["balance","regular","irregular","buffer","illustrativeHeadroom","sourceAsOf","asOf"] as const).every(key=>result[key]===range.review[key]);
 const [open,setOpen]=useState(false);
 const missingBalance=result.reasons.some(reason=>["balances_missing","balances_outdated","date_mismatch"].includes(reason));
 const prompt:Key=restricted?"scopeReserveNote":purpose==="save"?"planningReviewNoAllowance":missingBalance?"planningReviewBalance":range.estimate===null?"planningReviewIncome":"planningPrompt";
 const observed=result.reserveSource==="observed";
 const parts:[Key,number|null][]=[["availableBalance",result.balance],[observed ? "regularBillsObserved" : "regularBills",-result.regular],[observed ? "irregularReserveObserved" : "irregularReserve",-result.irregular],["buffer",-result.buffer],["savingsReserve",result.savings===null ? null : -result.savings]];
 const calculation=<>
  <p className="text-sm text-ink-2">{t("rangeBasis")}</p>
  {range.observedMonths<3 && <p className="text-sm text-ink-2">{t("planningReviewRecordedMonths",{count:range.observedMonths})}</p>}
  {observed && result.reserveMonths!==null && <p className="text-sm text-ink-2">{t("reserveObserved",{months:result.reserveMonths})}</p>}
  <dl className="divide-y divide-line">{parts.filter(([,value])=>!restricted && value!==null).map(([key,value])=><div key={key} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><dt>{t(key)}</dt><dd className="ml-auto font-semibold">{money(value!)}</dd></div>)}</dl>
  {result.illustrativeHeadroom!==null && !restricted && <p className="text-sm">{t(purpose==="save" ? "afterReserves" : "beforeTarget")}: <strong>{money(result.illustrativeHeadroom)}</strong></p>}
  <section aria-label={t("planningReviewTitle")} className="space-y-3">
   <h3 className="font-semibold">{t("planningReviewTitle")}</h3>
   <ul className="list-disc space-y-2 pl-5 text-sm text-ink-2">
    {restricted && <li>{t("planningReviewScope")}</li>}
    {missingBalance && <li>{t("planningReviewBalance")}</li>}
    {range.estimate===null && <li>{t("planningReviewIncome")}</li>}
    {!planning.billsConfirmed && <li>{t("planningReviewBills")}</li>}
    {queue.length>0 && <li>{t("planningReviewCategories")}</li>}
    {result.reasons.map(reason=><li key={reason}>{t(reasonCopy[reason])}</li>)}
   </ul>
   {!restricted && compatible && <div className="flex flex-wrap gap-3">
    <Button variant="outline" disabled={planning.billsConfirmed} onClick={planning.confirmBills}>{t(planning.billsConfirmed ? "billsConfirmed" : "confirmBills")}</Button>
    {queue.length>0 && <ReviewQueue period={planning.period}/>}
    {!calculationOnly && range.estimate===null && <Button variant="outline" onClick={()=>{setOpen(false);planning.openIncome();}}>{t("addIncome")}</Button>}
   </div>}
   <p className="text-caption text-ink-2">{t("planningReviewSnapshotOnly")}</p>
  </section>
  <p className="text-caption text-ink-2">{t("savingTargetRate",{rate:percent(result.savingsPercent)})}</p>
  <p className="text-caption text-ink-2">{t("sourceSnapshot",{date:date(result.sourceAsOf)})}</p>
  <p className="text-caption text-ink-2">{t(purpose==="save" ? "notSavingAllowance" : "notAllowance")}</p>
 </>;
 if(calculationOnly)return <div className="space-y-4">{calculation}</div>;
 return <Card><CardContent className="space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t(purpose==="save" ? "saveRoom" : "week")}</h2><Badge variant="secondary">{t(range.confidence==="low" ? "confidenceLow" : "confidenceMedium")}</Badge></div>
 {purpose==="spend" && !restricted && compatible && range.low!==null && range.high!==null && range.high>0 ? <p className="text-3xl font-bold tabular-nums">{t("rangeAbout",{low:money(range.low),high:money(range.high)})}</p> : <p className="font-semibold">{t(prompt)}</p>}
 {!compatible && <div className="space-y-2 text-caption text-ink-2">{result.reasons.map(reason=><p key={reason}>{t(reasonCopy[reason])}</p>)}<p>{t("sourceSnapshot",{date:date(result.sourceAsOf)})}</p></div>}
 <p className="text-caption text-ink-2">{t("rangeNote")}</p>
 {range.incomeSource && <p className="text-caption text-ink-2">{t(range.incomeSource==="user" ? "yourEstimate" : "inferredIncome")}: {money(range.estimate!)}</p>}
 {observed && !restricted && result.reserveMonths!==null && <p className="text-caption text-ink-2">{t("reserveObserved",{months:result.reserveMonths})}</p>}
 <Drawer open={open} onOpenChange={setOpen}><DrawerTrigger asChild><Button variant="outline">{t("calculation")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("calculation")}</DrawerTitle><DrawerDescription>{t("rangeNote")}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-4 overflow-y-auto px-4">{calculation}</div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
 {purpose==="save" && onGoal && <Button className="h-auto min-h-12 max-w-full whitespace-normal" onClick={onGoal}>{t("goal")}</Button>}
 </CardContent></Card>;
}
