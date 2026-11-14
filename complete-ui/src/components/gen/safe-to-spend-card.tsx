"use client";
import {useMoneyData} from "@/lib/money-data-context";

import {useCopy,type Key} from "@/i18n/context";
import {money,date,percent} from "@/lib/format";
import {usePlanning} from "@/lib/planning-context";
import {weeklyRange} from "@/engine/planning";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "@/components/ui/drawer";
import {Card,CardContent} from "@/components/ui/card";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import type {safeToSpend,ReviewReason} from "@/engine";
const reasonCopy:Record<ReviewReason,Key>={history_incomplete:"incompleteHistory",schedule_unreviewed:"unreviewedSchedule",balances_missing:"missingBalances",income_missing:"noIncome",date_mismatch:"stale",balances_outdated:"outdatedBalances"};
export function SafeToSpendCard({result,purpose="spend",onGoal,calculationOnly=false}:{result:ReturnType<typeof safeToSpend>;purpose?:"spend"|"save";onGoal?:()=>void;calculationOnly?:boolean}) {
 const {data,queue,scope}=useMoneyData(),restricted=scope.excludedAccounts.length>0 || scope.excludedCategories.length>0,{t}=useCopy(),planning=usePlanning(),range=weeklyRange({data,income:planning.income,savingsPercent:result.savingsPercent,billsConfirmed:planning.billsConfirmed,classificationsReviewed:queue.length===0});
 const compatible=(["balance","regular","irregular","buffer","illustrativeHeadroom","sourceAsOf","asOf"] as const).every(key=>result[key]===range.review[key]);
 const parts:[Key,number|null][]=[["availableBalance",result.balance],["regularBills",-result.regular],["irregularReserve",-result.irregular],["buffer",-result.buffer],["savingsReserve",result.savings===null ? null : -result.savings]];
 const calculation=<><p className="text-sm text-ink-2">{t("rangeBasis")}</p><dl className="divide-y divide-line">{parts.filter(([,value])=>!restricted && value!==null).map(([key,value])=><div key={key} className="flex flex-wrap justify-between gap-2 py-3 text-sm"><dt>{t(key)}</dt><dd className="ml-auto font-semibold">{money(value!)}</dd></div>)}</dl>{result.illustrativeHeadroom!==null && !restricted && <p className="text-sm">{t(purpose==="save" ? "afterReserves" : "beforeTarget")}: <strong>{money(result.illustrativeHeadroom)}</strong></p>}<p className="text-sm text-ink-2">{t(purpose==="save" ? "safeSaveNote" : "billsConfirmNote")}</p><Button variant="outline" disabled={planning.billsConfirmed} onClick={planning.confirmBills}>{t(planning.billsConfirmed ? "billsConfirmed" : "confirmBills")}</Button><ul className="list-disc space-y-2 pl-5 text-sm text-ink-2">{result.reasons.map(reason=><li key={reason}>{t(reasonCopy[reason])}</li>)}</ul><p className="text-caption text-ink-2">{t("savingTargetRate",{rate:percent(result.savingsPercent)})}</p><p className="text-caption text-ink-2">{t("sourceSnapshot",{date:date(result.sourceAsOf)})}</p><p className="text-caption text-ink-2">{t(purpose==="save" ? "notSavingAllowance" : "notAllowance")}</p></>;
 if(calculationOnly)return <div className="space-y-4">{calculation}</div>;
 return <Card><CardContent className="space-y-4 p-4"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t(purpose==="save" ? "saveRoom" : "week")}</h2><Badge variant="secondary">{t(range.confidence==="low" ? "confidenceLow" : "confidenceMedium")}</Badge></div>
 {purpose==="spend" && compatible && range.low!==null && range.high!==null && range.high>0 ? <p className="text-3xl font-bold tabular-nums">{t("rangeAbout",{low:money(range.low),high:money(range.high)})}</p> : <p className="font-semibold">{t(restricted ? "scopeReserveNote" : "planningPrompt")}</p>}
 {!compatible && <div className="space-y-2 text-caption text-ink-2">{result.reasons.map(reason=><p key={reason}>{t(reasonCopy[reason])}</p>)}<p>{t("sourceSnapshot",{date:date(result.sourceAsOf)})}</p></div>}
 <p className="text-caption text-ink-2">{t("rangeNote")}</p>
 {range.incomeSource && <p className="text-caption text-ink-2">{t(range.incomeSource==="user" ? "yourEstimate" : "inferredIncome")}: {money(range.estimate!)}</p>}
 <Drawer><DrawerTrigger asChild><Button variant="outline">{t("calculation")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("calculation")}</DrawerTitle><DrawerDescription>{t("rangeNote")}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-4 overflow-y-auto px-4">{calculation}</div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
 {purpose==="save" && onGoal && <Button className="h-auto min-h-12 max-w-full whitespace-normal" onClick={onGoal}>{t("goal")}</Button>}
 </CardContent></Card>;
}
