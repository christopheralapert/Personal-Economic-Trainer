"use client";
import {useMoneyData} from "@/lib/money-data-context";
import {ChevronRight} from "lucide-react";
import {cva} from "class-variance-authority";
import {useCopy} from "@/i18n/context";
import {usePlanning} from "@/lib/planning-context";
import {exactSum} from "@/engine";
import {recurringIncome} from "@/engine/planning";
import {MoneyAmount} from "./money-amount";
const tile=cva("min-w-0 rounded-3xl p-4 text-left",{variants:{tone:{income:"bg-tile-income",saving:"bg-tile-saving",expenses:"col-span-2 bg-tile-grey"}}});
export function SummaryTiles({income,savings,expenses,onSelect}:{income:number|null;savings:number|null;expenses:number|null;onSelect?:(key:"income"|"saving"|"expenses")=>void}) {
  const {data}=useMoneyData(),{t}=useCopy(),planning=usePlanning(),planned=planning.plans.length ? exactSum(planning.plans.map(plan=>plan.monthlyMinor)) : null,estimated=planning.income??recurringIncome(data);return <div className="grid grid-cols-2 gap-3">{(["income","saving","expenses"] as const).map(key=>{
    const value=key==="income" ? income??estimated : key==="saving" ? savings??planned : expenses;
    return <button className={tile({tone:key})} key={key} onClick={()=>onSelect?.(key)} disabled={!onSelect}>
      <span className="flex min-h-6 items-start justify-between gap-2 font-semibold">{t(key==="saving" && savings===null && planned!==null ? "monthlyPlans" : key)}{onSelect && <ChevronRight className="size-5 shrink-0" aria-hidden="true"/>}</span>
      <span className={value===null ? "mt-4 block text-base font-semibold" : "mt-4 block text-2xl font-bold tabular-nums"}>{value===null ? t(key==="income" ? "needsInput" : key==="saving" ? "startPlan" : "emptyRecords") : <MoneyAmount minor={value}/>}</span>{key==="income" && income===null && estimated!==null && <span className="mt-2 block text-caption text-ink-2">{t(planning.income!==null ? "yourEstimate" : "inferredIncome")}</span>}{key==="saving" && savings===null && <span className="mt-2 block text-caption text-ink-2">{t("planNotMoved")}</span>}
    </button>;
  })}</div>;
}
