"use client";
import {useCopy,categoryLabel,basketLabel,type Key} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import type {spenderProfile} from "@/engine";
import {transactionQuestion} from "@/coach/explore-question";
import {Button} from "@/components/ui/button";
const styles={everyday_led:["styleEverydayLed","styleEverydayLedNote"],fixed_led:["styleFixedLed","styleFixedLedNote"],surprise_heavy:["styleSurpriseHeavy","styleSurpriseHeavyNote"],balanced:["styleBalanced","styleBalancedNote"]} as const satisfies Record<string,readonly [Key,Key]>;
const basketTone:Record<string,string>={mandatory_regular:"bg-basket-regular",mandatory_irregular:"bg-basket-surprises",everyday:"bg-basket-everyday",unresolved:"bg-basket-check"};
/** Gross basket shares as one stacked bar; labels stay in the basket answer and Overview. */
function BasketShareBar({baskets}:{baskets:ReturnType<typeof spenderProfile>["baskets"]}) {
  const {t}=useCopy(),total=baskets.reduce((sum,group)=>sum+group.gross,0);
  if(total<=0)return null;
  return <div className="flex h-3 w-full overflow-hidden rounded-full" role="img" aria-label={baskets.map(group=>`${basketLabel(group.key,t)} ${percent(group.gross/total*100)}`).join(", ")}>{baskets.filter(group=>group.gross>0).map(group=><span key={group.key} className={basketTone[group.key] ?? "bg-line"} style={{width:`${group.gross/total*100}%`}}/>)}</div>;
}
export function SpenderProfile({result,onAsk}:{result:ReturnType<typeof spenderProfile>;onAsk?:(question:string)=>void}) {
  const {t,locale}=useCopy(),question=result.leading && onAsk ? transactionQuestion(result.period,{category:result.leading.key},locale) : null;
  const style=result.style ? styles[result.style] : null;
  return <section className="space-y-4">{style && result.styleShare!==null && <div className="space-y-2 rounded-xl bg-brand-tint p-4"><h3 className="wrap-anywhere text-2xl font-bold">{t(style[0])}</h3><p className="text-base leading-relaxed">{t(style[1],{share:percent(result.styleShare)})}</p><BasketShareBar baskets={result.baskets}/></div>}<h3 className="wrap-anywhere text-lg font-semibold">{result.leading ? t("profileType",{category:categoryLabel(result.leading.key,t)}) : t("noPattern")}</h3><p className="text-sm text-ink-2">{t("patternNote")}</p>{result.leadingGrossShare!==null && <p className="text-sm text-ink-2">{t("profileShareBasis",{share:percent(result.leadingGrossShare)})}</p>}<dl className="divide-y divide-line">{([
    [t("leading"),result.leading ? categoryLabel(result.leading.key,t) : t("notAvailable")],
    [t("records"),String(result.count)],[t("total"),result.count ? money(result.total) : t("notAvailable")],
  ]).map(([key,value])=><div className="flex min-h-14 flex-wrap items-center justify-between gap-4 py-3" key={key}><dt>{key}</dt><dd className="min-w-0 wrap-anywhere text-right font-semibold">{value}</dd></div>)}</dl>{question && result.leading && <Button variant="link" className="h-auto min-h-12 max-w-full whitespace-normal text-left" onClick={()=>onAsk?.(question)}>{t("exploreCategory",{category:categoryLabel(result.leading.key,t)})}</Button>}</section>;
}
