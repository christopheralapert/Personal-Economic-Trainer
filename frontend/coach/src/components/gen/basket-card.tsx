"use client";
import {useCopy} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import {TickBar} from "./tick-bar";
import type {Group,Period} from "@/engine";
import {exactSum} from "@/engine";
import {transactionQuestion} from "@/coach/explore-question";
import {Button} from "@/components/ui/button";
export function BasketCard({groups,period,onAsk}:{groups:Group[];period?:Period;onAsk?:(question:string)=>void}) {
  const {t,locale}=useCopy(),total=exactSum(groups.map(g=>g.gross));
  const basket=[{key:"mandatory_regular",title:"regular",copy:"regularText",color:"bg-basket-regular"},{key:"mandatory_irregular",title:"irregular",copy:"irregularText",color:"bg-basket-surprises"},{key:"everyday",title:"everyday",copy:"everydayText",color:"bg-basket-everyday"},{key:"unresolved",title:"unresolved",copy:"unresolvedText",color:"bg-hatch"}] as const;
  return <div className="space-y-5"><div className="divide-y divide-line">{basket.filter(b=>b.key!=="unresolved" || groups.some(g=>g.key===b.key)).map(b=>{
    const g=groups.find(g=>g.key===b.key),share=total ? (g?.gross ?? 0)/total*100 : 0;
    const question=g && period && onAsk ? transactionQuestion(period,{basket:b.key},locale) : null;
    return <div className="py-4 first:pt-0" key={b.key}><dl className="flex flex-wrap items-baseline justify-between gap-4"><dt className="min-w-0 font-semibold">{question ? <Button variant="link" className="h-auto min-h-12 max-w-full justify-start whitespace-normal p-0 text-left font-semibold wrap-anywhere" aria-label={t("exploreBasket",{basket:t(b.title)})} onClick={()=>onAsk?.(question)}>{t(b.title)}</Button> : t(b.title)}</dt><dd className="text-right font-semibold">{g ? money(g.amount) : t("notRecorded")}</dd></dl>
      <p className="mt-1 text-caption text-ink-2">{g && total>0 ? percent(share) : t("notAvailable")} · {t(b.copy)}</p></div>;
  })}</div><TickBar parts={basket.map(b=>({value:groups.find(g=>g.key===b.key)?.gross ?? 0,className:b.color}))} caption={t("gross")}/></div>;
}
