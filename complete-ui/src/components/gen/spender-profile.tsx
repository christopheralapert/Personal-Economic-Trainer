"use client";
import {useCopy,categoryLabel} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import type {spenderProfile} from "@/engine";
import {transactionQuestion} from "@/coach/explore-question";
import {Button} from "@/components/ui/button";
export function SpenderProfile({result,onAsk}:{result:ReturnType<typeof spenderProfile>;onAsk?:(question:string)=>void}) {
  const {t,locale}=useCopy(),question=result.leading && onAsk ? transactionQuestion(result.period,{category:result.leading.key},locale) : null;
  return <section className="space-y-4"><h3 className="wrap-anywhere text-xl font-bold">{result.leading ? t("profileType",{category:categoryLabel(result.leading.key,t)}) : t("noPattern")}</h3><p className="text-sm text-ink-2">{t("patternNote")}</p>{result.leadingGrossShare!==null && <p className="text-sm text-ink-2">{t("profileShareBasis",{share:percent(result.leadingGrossShare)})}</p>}<dl className="divide-y divide-line">{([
    [t("leading"),result.leading ? categoryLabel(result.leading.key,t) : t("notAvailable")],
    [t("records"),String(result.count)],[t("total"),result.count ? money(result.total) : t("notAvailable")],
  ]).map(([key,value])=><div className="flex min-h-14 flex-wrap items-center justify-between gap-4 py-3" key={key}><dt>{key}</dt><dd className="min-w-0 wrap-anywhere text-right font-semibold">{value}</dd></div>)}</dl>{question && result.leading && <Button variant="link" className="h-auto min-h-12 max-w-full whitespace-normal text-left" onClick={()=>onAsk?.(question)}>{t("exploreCategory",{category:categoryLabel(result.leading.key,t)})}</Button>}</section>;
}
