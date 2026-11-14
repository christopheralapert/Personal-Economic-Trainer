"use client";
import {useViewState} from "@/lib/view-state";
import {useMoneyData} from "@/lib/money-data-context";
import {useCopy,categoryLabel} from "@/i18n/context";
import {MoneyAmount} from "./money-amount";
import {money,percent,precisePercent} from "@/lib/format";
import {simulateReduction,type Period} from "@/engine";
import {Slider} from "@/components/ui/slider";
export function WhatIfSlider({category,initialPct=20,period,onChange,value,onPercentChange,showResult=true,compact=false}:{category:string;initialPct?:number;period:Period;onChange?:(minor:number)=>void;value?:number;onPercentChange?:(pct:number)=>void;showResult?:boolean;compact?:boolean}) {
 const {data}=useMoneyData(),{t}=useCopy(),[localPct,setPct]=useViewState(`pct:${category}/${period.start}/${period.end}`,initialPct),pct=value??localPct,result=simulateReduction(category,pct,period,data);
 return <section className={compact ? "space-y-1 border-t border-line pt-3" : "space-y-5 border-b border-line py-5"}><div className="flex items-center justify-between gap-3"><h3 className="min-w-0 wrap-anywhere font-semibold">{categoryLabel(category,t)}</h3><span className="shrink-0 font-semibold">{compact ? money(result.monthly) : precisePercent(pct)}</span></div>{!compact && <p className="text-caption text-ink-2">{t("baseline")}: {money(result.baseline)}</p>}
 <div className="flex items-center gap-3"><Slider aria-label={`${t("reduce")} ${categoryLabel(category,t)}`} aria-valuetext={precisePercent(pct)} className="min-h-12 flex-1" min={0} max={100} step={1} value={[pct]} onValueChange={([next])=>{setPct(next);onPercentChange?.(next);onChange?.(simulateReduction(category,next,period,data).monthly);}}/>{compact && <span className="min-w-12 text-right text-caption text-ink-2">{precisePercent(pct)}</span>}</div>
 {!compact && (showResult ? <dl className="grid grid-cols-2 gap-3 rounded-3xl bg-tile-saving p-4"><div><dt className="text-caption text-ink-2">{t("perMonth")}</dt><dd className="mt-1 text-xl font-bold"><MoneyAmount minor={result.monthly}/></dd></div><div><dt className="text-caption text-ink-2">{t("perYear")}</dt><dd className="mt-1 text-xl font-bold"><MoneyAmount minor={result.annual}/></dd></div>{result.incomeShare!==null && <div className="col-span-2"><dt className="text-caption text-ink-2">{t("shareIncome")}</dt><dd className="text-sm">{percent(result.incomeShare)}</dd></div>}</dl> : <p className="text-sm text-ink-2">{t("perYear")}: <strong>{money(result.annual)}</strong></p>)}
 </section>;
}
