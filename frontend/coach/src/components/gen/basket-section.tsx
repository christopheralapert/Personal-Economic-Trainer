"use client";
import type {ReactNode} from "react";
import {ChevronRight} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import {TickBar} from "./tick-bar";

export type BasketKey="mandatory_regular"|"mandatory_irregular"|"everyday"|"unresolved";
const baskets:{key:BasketKey;name:Key;line:Key;dot:string}[]=[
  {key:"mandatory_regular",name:"regularShort",line:"regularLine",dot:"bg-basket-regular"},
  {key:"mandatory_irregular",name:"surprisesShort",line:"surprisesLine",dot:"bg-basket-surprises"},
  {key:"everyday",name:"everydayShort",line:"everydayLine",dot:"bg-basket-everyday"},
];

/**
 * One proportional bar plus one text row per basket. Shares use all gross spending in the period, so the bar adds up
 * to 100 % including the hatched "To check" part. The "To check" row owns the single review action.
 */
export function BasketSection({values,toCheckCount=0,reviewAction,onBasket,basketHref}:{values:{key:string;gross:number}[];toCheckCount?:number;reviewAction?:ReactNode;onBasket?:(key:BasketKey)=>void;basketHref?:(key:BasketKey)=>string}) {
  const {t}=useCopy();
  const gross=(key:BasketKey)=>values.filter(value=>value.key===key).reduce((sum,value)=>sum+Math.max(0,value.gross),0);
  const total=[...baskets.map(b=>b.key),"unresolved" as const].reduce((sum,key)=>sum+gross(key),0);
  if(total<=0) return null;
  const share=(key:BasketKey)=>percent(gross(key)/total*100);
  const unresolved=gross("unresolved");
  const label=t("basketBarLabel",{list:[...baskets.map(b=>`${t(b.name)} ${share(b.key)}`),...(unresolved>0 ? [`${t("unclassifiedShort")} ${share("unresolved")}`] : [])].join(", ")});
  const row=(content:ReactNode,key:BasketKey)=>{
    const className="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-tile-grey focus-visible:bg-tile-grey";
    return basketHref ? <a className={`${className} text-ink no-underline`} href={basketHref(key)}>{content}</a> : <button type="button" className={className} onClick={()=>onBasket?.(key)}>{content}</button>;
  };
  return <section className="space-y-3" aria-label={t("basketsTitle")}>
    <TickBar label={label} caption="" parts={[...baskets.map(b=>({value:gross(b.key),className:b.dot})),{value:unresolved,className:"bg-hatch"}]}/>
    <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
      {baskets.map(b=><li key={b.key}>{row(<>
        <span className={`size-3 shrink-0 rounded-full ${b.dot}`} aria-hidden="true"/>
        <span className="min-w-0 flex-1"><span className="block text-base font-medium">{t(b.name)}</span><span className="block text-caption text-ink-2">{t(b.line)}</span></span>
        <span className="shrink-0 text-right"><span className="block text-sm font-semibold tabular-nums">{money(gross(b.key))}</span><span className="block text-caption tabular-nums text-ink-2">{share(b.key)}</span></span>
        <ChevronRight className="size-4 shrink-0 text-ink-2" aria-hidden="true"/>
      </>,b.key)}</li>)}
      {toCheckCount>0 && <li className="flex min-h-14 items-center gap-3 px-4 py-3">
        <span className="size-3 shrink-0 rounded-full bg-hatch ring-1 ring-basket-check" aria-hidden="true"/>
        <span className="min-w-0 flex-1"><span className="block text-base font-medium">{t("unclassifiedShort")}</span><span className="block text-caption text-ink-2">{t("toCheckPayments",{count:toCheckCount})}</span></span>
        {reviewAction}
      </li>}
    </ul>
  </section>;
}
