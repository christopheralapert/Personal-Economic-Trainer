"use client";
import {useCopy,categoryLabel} from "@/i18n/context";
import {money} from "@/lib/format";
import {CategoryIcon} from "./category-icon";
import type {Group} from "@/engine";
import type {Period} from "@/engine";
import {transactionQuestion} from "@/coach/explore-question";
import {Button} from "@/components/ui/button";
export function CategoryList({groups,period,onAsk}:{groups:Group[];period?:Period;onAsk?:(question:string)=>void}) {
  const {t,locale}=useCopy();return groups.length ? <ul className="divide-y divide-line">{groups.map(g=>{
    const question=period && onAsk ? transactionQuestion(period,{category:g.key},locale) : null;
    return <li key={g.key} className="flex min-h-14 items-center gap-3 py-3"><CategoryIcon category={g.key}/><span className="min-w-0 flex-1 wrap-anywhere">{question ? <Button variant="link" className="h-auto min-h-12 max-w-full justify-start whitespace-normal p-0 text-left font-normal wrap-anywhere" aria-label={t("exploreCategory",{category:categoryLabel(g.key,t)})} onClick={()=>onAsk?.(question)}>{categoryLabel(g.key,t)}</Button> : categoryLabel(g.key,t)}</span><span className="shrink-0 font-semibold">{money(g.amount)}</span></li>;
  })}</ul> : <p className="text-sm text-ink-2">{t("emptyRecords")}</p>;
}
