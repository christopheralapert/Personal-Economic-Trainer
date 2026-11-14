"use client";
import {TransactionSheet} from "../transaction-sheet";
import {useId,useMemo,useState} from "react";
import {useViewState} from "@/lib/view-state";
import {PieChart,Pie,Cell,ResponsiveContainer,type PieLabelRenderProps} from "recharts";
import {useCopy,categoryLabel} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import {categoryBreakdown,rollupLimit,type CategorySegment} from "@/lib/category-breakdown";
import {CategoryIcon,categoryGlyph,categoryRingIndex,categoryTone} from "./category-icon";
import {CategoryList} from "./category-list";
import {Progress} from "@/components/ui/progress";
import type {Group,Period} from "@/engine";

/** Segments below this share carry no icon in the ring; the legend still names them. */
const iconShare=0.06;

export function DonutBreakdown({groups,stateKey="default",period,onAsk,compact=false,alwaysRing=false,onCategory,netPresentation=compact,totalLabel,showTotal=true}:{groups:Group[];stateKey?:string;period?:Period;onAsk?:(question:string)=>void;compact?:boolean;alwaysRing?:boolean;onCategory?:(categories:string[])=>void;netPresentation?:boolean;totalLabel?:string;showTotal?:boolean}) {
  const [sheetOpen,setSheetOpen]=useState(false),{t}=useCopy(),[selected,setSelected]=useViewState<string|null>(`category:${stateKey}`,null),hatch=`hatch-${useId().replace(/:/gu,"")}`;
  const breakdown=useMemo(()=>categoryBreakdown(netPresentation ? groups.map(group=>({...group,gross:Math.max(0,group.amount),refunds:Math.max(0,-group.amount)})) : groups),[groups,netPresentation]),data=breakdown.segments,total=breakdown.gross,ring=total>0 && (alwaysRing || data.length>2);
  // Fixed ring order: each colour always has the same validated neighbours; the legend stays sorted by size.
  const ringData=useMemo(()=>[...data].sort((a,b)=>categoryRingIndex(a.category)-categoryRingIndex(b.category) || b.gross-a.gross),[data]);
  const title=(segment:CategorySegment)=>segment.category===null ? t("remainingCategories") : categoryLabel(segment.category,t);
  const selection=data.find(segment=>segment.id===selected);
  const fill=(segment:CategorySegment)=>categoryTone(segment.category)==="none" ? `url(#${hatch})` : `var(--cat-${categoryTone(segment.category)})`;
  function toggle(id:string){if(onCategory){const segment=data.find(item=>item.id===id);if(segment)onCategory(segment.members.map(item=>item.key));return;}setSelected(id);setSheetOpen(true);}
  function label(props:PieLabelRenderProps) {
    const index=props.index ?? 0,g=ringData[index];if(!g || !total || g.gross/total<iconShare || categoryTone(g.category)==="none") return null;
    const angle=Number(props.midAngle)*Math.PI/180,r=(Number(props.innerRadius)+Number(props.outerRadius))/2;
    const x=Number(props.cx)+r*Math.cos(-angle),y=Number(props.cy)+r*Math.sin(-angle),Icon=g.category===null ? categoryGlyph("other") : categoryGlyph(g.category);
    return <Icon x={x-9} y={y-9} width={18} height={18} stroke="var(--chart-ink)" pointerEvents="none" aria-hidden="true"/>;
  }
  if(!groups.length) return <p className="text-sm text-ink-2">{t("emptyRecords")}</p>;
  return <div className={compact ? "space-y-3" : "space-y-5"} data-chart-total={breakdown.net}>
    <svg className="absolute size-0" aria-hidden="true" focusable="false"><defs><pattern id={hatch} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--surface)"/><rect width="2.4" height="6" fill="var(--cat-none)"/></pattern></defs></svg>
    {ring && <div className={compact ? "overview-chart mx-auto aspect-square" : "mx-auto aspect-square w-full max-w-sm"} aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer={false}>{compact && showTotal && <text x="50%" y="48%" textAnchor="middle" fill="var(--ink)" className="text-xl font-semibold">{money(breakdown.net)}</text>}{compact && showTotal && <text x="50%" y="59%" textAnchor="middle" fill="var(--ink-2)" className="text-caption">{totalLabel??t("spentShort")}</text>}<Pie rootTabIndex={-1} data={ringData} dataKey="gross" nameKey="id" cx="50%" cy="50%" innerRadius="62%" outerRadius="96%" startAngle={90} endAngle={-270} paddingAngle={1.5} stroke="var(--surface)" strokeWidth={2} labelLine={false} label={label} isAnimationActive={false} onClick={(_,i)=>toggle(ringData[i].id)}>{ringData.map(g=><Cell key={g.id} fill={fill(g)}/>)}</Pie></PieChart></ResponsiveContainer></div>}
    <div className={!ring ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-x-3 gap-y-1"}>{data.map(g=><button key={g.id} className="flex min-h-12 min-w-0 items-center gap-3 rounded-xl text-left" aria-pressed={!onCategory ? selected===g.id : undefined} onClick={()=>toggle(g.id)}><CategoryIcon category={g.category} size="dense"/><span className="min-w-0 flex-1"><span className="block text-sm font-medium leading-snug wrap-anywhere">{title(g)}</span><span data-category-amount={g.amount} className="block text-caption tabular-nums text-ink-2">{money(g.gross)} · {percent(g.gross/total*100)}</span>{!ring && <Progress className="mt-2" value={g.gross/total*100} aria-label={title(g)} aria-valuetext={`${money(g.gross)} · ${percent(g.gross/total*100)}`}/>}</span></button>)}</div>
    {breakdown.rollupShare>=rollupLimit && <p className="text-caption text-ink-2">{t("otherStillLarge",{share:percent(breakdown.rollupShare*100)})}</p>}
    {!compact && breakdown.refunds>0 && <p className="text-caption leading-relaxed text-ink-2">{t("chartAccounting")}</p>}
    {compact && !ring && <p className="text-xl font-semibold">{money(breakdown.net)} <span className="text-sm font-normal text-ink-2">{totalLabel??t("spentShort")}</span></p>}{!compact && <dl className="divide-y divide-line">{([["gross",breakdown.gross],["refunds",breakdown.refunds],["net",breakdown.net]] as const).filter(([key])=>breakdown.refunds>0 || key==="gross").map(([key,value])=><div key={key} className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-2"><dt className="text-sm text-ink-2">{t(key)}</dt><dd className="text-sm font-semibold">{money(value)}</dd></div>)}</dl>}
    <div className="sr-only"><table><caption>{t("categoryReconciliation")}</caption><thead><tr><th scope="col">{t("category")}</th><th scope="col">{t("gross")}</th><th scope="col">{t("refunds")}</th><th scope="col">{t("net")}</th><th scope="col">{t("share")}</th></tr></thead><tbody>{groups.map(g=><tr key={g.key}><th scope="row">{categoryLabel(g.key,t)}</th><td>{money(g.gross)}</td><td>{money(g.refunds)}</td><td>{money(g.amount)}</td><td>{total>0 ? percent((compact ? g.amount : g.gross)/total*100) : t("notAvailable")}</td></tr>)}</tbody></table></div>
    {breakdown.withoutGross.length>0 && <section className="space-y-3 border-t border-line pt-4"><h3 className="font-semibold">{t("withoutGross")}</h3><p className="text-caption text-ink-2">{t("withoutGrossNote")}</p><CategoryList groups={breakdown.withoutGross} period={period} onAsk={onAsk}/></section>}
    {!onCategory && selection && period && <TransactionSheet key={`${selection.id}/${period.start}/${period.end}`} period={period} categories={selection.members.map(group=>group.key)} title={title(selection)} open={sheetOpen} onOpenChange={setSheetOpen} onAsk={onAsk}/>}
  </div>;
}
