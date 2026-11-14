"use client";
import {TransactionSheet} from "../transaction-sheet";
import {useMemo,useState} from "react";
import {useViewState} from "@/lib/view-state";
import {PieChart,Pie,Cell,ResponsiveContainer,type PieLabelRenderProps} from "recharts";
import {useCopy,categoryLabel} from "@/i18n/context";
import {money,percent} from "@/lib/format";
import {categoryBreakdown,type CategorySegment} from "@/lib/category-breakdown";
import {CategoryIcon,categoryGlyph,categoryTone} from "./category-icon";
import {CategoryList} from "./category-list";
import {Progress} from "@/components/ui/progress";
import type {Group,Period} from "@/engine";

export function DonutBreakdown({groups,stateKey="default",period,onAsk,compact=false,alwaysRing=false,onCategory,netPresentation=compact,totalLabel}:{groups:Group[];stateKey?:string;period?:Period;onAsk?:(question:string)=>void;compact?:boolean;alwaysRing?:boolean;onCategory?:(categories:string[])=>void;netPresentation?:boolean;totalLabel?:string}) {
  const [sheetOpen,setSheetOpen]=useState(false),{t}=useCopy(),[selected,setSelected]=useViewState<string|null>(`category:${stateKey}`,null);
  const breakdown=useMemo(()=>categoryBreakdown(netPresentation ? groups.map(group=>({...group,gross:Math.max(0,group.amount),refunds:Math.max(0,-group.amount)})) : groups),[groups,netPresentation]),data=breakdown.segments,total=breakdown.gross,ring=total>0 && (alwaysRing || data.length>2);
  const title=(segment:CategorySegment)=>segment.category===null ? t("remainingCategories") : categoryLabel(segment.category,t);
  const selection=data.find(segment=>segment.id===selected);
  function toggle(id:string){if(onCategory){const segment=data.find(item=>item.id===id);if(segment)onCategory(segment.members.map(item=>item.key));return;}setSelected(id);setSheetOpen(true);}
  function label(props:PieLabelRenderProps) {
    const index=props.index ?? 0,g=data[index];if(!g || !total) return null;
    const angle=Number(props.midAngle)*Math.PI/180,r=(Number(props.innerRadius)+Number(props.outerRadius))/2;
    const x=Number(props.cx)+r*Math.cos(-angle),y=Number(props.cy)+r*Math.sin(-angle),Icon=categoryGlyph(g.category ?? "other");
    return <g fill="var(--chart-ink)" textAnchor="middle" pointerEvents="none"><Icon x={x-10} y={y-17} width={20} height={20} stroke="var(--chart-ink)" aria-hidden="true"/><text x={x} y={y+16} className="text-chart font-semibold">{percent(g.gross/total*100)}</text></g>;
  }
  if(!groups.length) return <p className="text-sm text-ink-2">{t("emptyRecords")}</p>;
  return <div className={compact ? "space-y-2" : "space-y-5"} data-chart-total={breakdown.net}>{ring && <div className={compact ? "overview-chart mx-auto aspect-square" : "mx-auto aspect-square w-full max-w-sm"} aria-hidden="true"><ResponsiveContainer width="100%" height="100%"><PieChart accessibilityLayer={false}>{compact && <text x="50%" y="48%" textAnchor="middle" fill="var(--ink)" className="text-xl font-bold">{money(breakdown.net)}</text>}{compact && <text x="50%" y="59%" textAnchor="middle" fill="var(--ink-2)" className="text-caption">{totalLabel??t("spentShort")}</text>}<Pie rootTabIndex={-1} data={data} dataKey="gross" nameKey="id" cx="50%" cy="50%" innerRadius="54%" outerRadius="92%" paddingAngle={2} stroke="var(--chart-ink)" strokeWidth={2} labelLine={false} label={label} isAnimationActive={false} onClick={(_,i)=>toggle(data[i].id)}>{data.map(g=><Cell key={g.id} fill={`var(--cat-${categoryTone(g.category ?? "other")})`}/>)}</Pie></PieChart></ResponsiveContainer></div>}
    <div className={!ring ? "grid grid-cols-1 gap-2" : "grid grid-cols-2 gap-x-3 gap-y-2"}>{data.map(g=><button key={g.id} className="flex min-h-12 min-w-0 items-center gap-2 text-left" aria-pressed={selected===g.id} onClick={()=>toggle(g.id)}><CategoryIcon category={g.category ?? "other"} size="dense"/><span className="min-w-0 flex-1"><span data-category-amount={g.amount} className="block wrap-anywhere text-sm font-semibold">{money(g.gross)}</span><span className="block wrap-anywhere text-caption text-ink-2">{title(g)} · {percent(g.gross/total*100)}</span>{!ring && <Progress className="mt-2" value={g.gross/total*100} aria-label={title(g)} aria-valuetext={`${money(g.gross)} ? ${percent(g.gross/total*100)}`}/>}</span></button>)}</div>
    {!compact && breakdown.refunds>0 && <p className="text-caption leading-relaxed text-ink-2">{t("chartAccounting")}</p>}
    {compact && !ring && <p className="text-xl font-semibold">{money(breakdown.net)} <span className="text-sm font-normal text-ink-2">{totalLabel??t("spentShort")}</span></p>}{!compact && <dl className="divide-y divide-line">{([["gross",breakdown.gross],["refunds",breakdown.refunds],["net",breakdown.net]] as const).filter(([key])=>breakdown.refunds>0 || key==="gross").map(([key,value])=><div key={key} className="flex min-h-12 flex-wrap items-center justify-between gap-3 py-2"><dt className="text-sm text-ink-2">{t(key)}</dt><dd className="text-sm font-semibold">{money(value)}</dd></div>)}</dl>}
    <div className="sr-only"><table><caption>{t("categoryReconciliation")}</caption><thead><tr><th scope="col">{t("category")}</th><th scope="col">{t("gross")}</th><th scope="col">{t("refunds")}</th><th scope="col">{t("net")}</th><th scope="col">{t("share")}</th></tr></thead><tbody>{groups.map(g=><tr key={g.key}><th scope="row">{categoryLabel(g.key,t)}</th><td>{money(g.gross)}</td><td>{money(g.refunds)}</td><td>{money(g.amount)}</td><td>{total>0 ? percent((compact ? g.amount : g.gross)/total*100) : t("notAvailable")}</td></tr>)}</tbody></table></div>
    {breakdown.withoutGross.length>0 && <section className="space-y-3 border-t border-line pt-4"><h3 className="font-semibold">{t("withoutGross")}</h3><p className="text-caption text-ink-2">{t("withoutGrossNote")}</p><CategoryList groups={breakdown.withoutGross} period={period} onAsk={onAsk}/></section>}
    {!onCategory && selection && period && <TransactionSheet key={`${selection.id}/${period.start}/${period.end}`} period={period} categories={selection.members.map(group=>group.key)} title={title(selection)} open={sheetOpen} onOpenChange={setSheetOpen} onAsk={onAsk}/>}
  </div>;
}
