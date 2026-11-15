"use client";
import {useMemo,useRef,useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";
import {useCopy,categoryLabel} from "@/i18n/context";
import {money,date} from "@/lib/format";
import {paydayForecast,type PaydayResult} from "@/engine/payday";
import {Card,CardContent} from "@/components/ui/card";
import {Badge} from "@/components/ui/badge";
import {Button} from "@/components/ui/button";
import {Slider} from "@/components/ui/slider";

const delays=[0,3,7] as const;
const selectedChip="border-brand bg-brand-tint text-active-ink dark:bg-brand-tint dark:hover:bg-brand-tint";

/** Until-payday plan: per-day room, balance chart with forecast, purchase and late-salary controls. */
export function PaydayPlanner({result}:{result:PaydayResult}) {
 const {data}=useMoneyData(),{t}=useCopy();
 const [purchase,setPurchase]=useState(result.purchase),[delay,setDelay]=useState(result.delayDays);
 // The answer card keeps the asked scenario; controls recompute locally from the same records.
 const plan=useMemo(()=>purchase===result.purchase && delay===result.delayDays ? result : paydayForecast({data,today:result.today,purchase,delayDays:delay}),[data,result,purchase,delay]);
 if(plan.status==="unavailable")return <Card><CardContent className="space-y-2 p-4"><h2 className="font-semibold">{t("paydayTitle")}</h2><p className="text-sm text-ink-2">{t(plan.reason==="income" ? "paydayNoIncome" : "paydayNoBalance")}</p></CardContent></Card>;
 const tight=plan.perDay<plan.usualPerDay;
 const rows:[string,number][]=[[t("paydayBalance"),plan.balance],[t("paydayBills"),-plan.billsTotal],[t("paydayBuffer"),-plan.buffer],...(plan.purchase>0 ? [[t("paydayPurchase"),-plan.purchase] as [string,number]] : [])];
 return <Card data-payday-planner><CardContent className="space-y-4 p-4">
  <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{t("paydayTitle")}</h2><Badge variant="secondary">{t("confidenceLow")}</Badge></div>
  <div className="space-y-1">
   <p aria-live="polite" className="text-3xl font-bold tabular-nums">{t("paydayPerDay",{amount:money(plan.perDay)})}</p>
   <p className="text-sm text-ink-2">{t("paydayDays",{days:plan.days,date:date(plan.payday)})}</p>
  </div>
  <div className="space-y-1 text-sm">
   <p>{t("paydayUsual",{amount:money(plan.usualPerDay)})}</p>
   <p className={tight ? "font-semibold" : "text-ink-2"}>{plan.runsOutOn ? t("paydayRunsOut",{date:date(plan.runsOutOn)}) : t(tight ? "paydayTight" : "paydayOnTrack")}</p>
  </div>
  <BalanceChart plan={plan}/>
  <div className="space-y-2">
   <div className="flex items-center justify-between gap-2 text-sm"><span id="payday-purchase">{t("paydayPurchase")}</span><span className="font-semibold tabular-nums">{money(purchase)}</span></div>
   <Slider aria-labelledby="payday-purchase" aria-valuetext={money(purchase)} min={0} max={100000} step={1000} value={[purchase]} onValueChange={([value])=>setPurchase(value)}/>
  </div>
  <div className="space-y-2">
   <p className="text-sm" id="payday-delay">{t("paydayDelay")}</p>
   <div role="radiogroup" aria-labelledby="payday-delay" className="flex flex-wrap gap-2">{delays.map(value=><Button key={value} role="radio" aria-checked={delay===value} variant="outline" size="chip" className={delay===value ? selectedChip : ""} onClick={()=>setDelay(value)}>{value===0 ? t("paydayOnTime") : t("paydayLateDays",{days:value})}</Button>)}</div>
  </div>
  <dl className="divide-y divide-line">
   {rows.map(([label,value])=><div key={label} className="flex justify-between gap-2 py-2 text-sm"><dt>{label}</dt><dd className="tabular-nums">{money(value)}</dd></div>)}
   <div className="flex justify-between gap-2 py-2 text-sm font-semibold"><dt>{t("paydayLeft")}</dt><dd className="tabular-nums">{money(plan.available)}</dd></div>
  </dl>
  <section aria-label={t("paydayBills")} className="space-y-2">
   <h3 className="text-sm font-semibold">{t("paydayBills")}</h3>
   {plan.bills.length ? <ul className="space-y-1 text-sm">{plan.bills.map(bill=><li key={bill.date+bill.category+bill.amount} className="flex justify-between gap-2"><span>{date(bill.date)} · {categoryLabel(bill.category,t)}</span><span className="tabular-nums">{money(-bill.amount)}</span></li>)}</ul> : <p className="text-sm text-ink-2">{t("paydayNoBills")}</p>}
   <p className="text-sm text-ink-2">{t("paydayIncome")}: {money(plan.income)} · {date(plan.payday)}</p>
  </section>
  <p className="text-caption text-ink-2">{t("paydayNote")}</p>
 </CardContent></Card>;
}

const W=320,H=160,PAD={top:12,right:8,bottom:22,left:8};
/** One balance series: solid actual history, dashed forecast at the usual pace, bills as markers. */
function BalanceChart({plan}:{plan:Extract<PaydayResult,{status:"ready"}>}) {
 const {t}=useCopy(),box=useRef<SVGSVGElement>(null),[hover,setHover]=useState<number|null>(null);
 const points=[...plan.history,...plan.forecast.slice(1)],first=Date.parse(points[0].date),last=Date.parse(points.at(-1)!.date);
 const values=points.map(p=>p.balance),low=Math.min(0,...values),high=Math.max(...values)*1.05||1;
 const x=(iso:string)=>PAD.left+(Date.parse(iso)-first)/Math.max(1,last-first)*(W-PAD.left-PAD.right);
 const y=(value:number)=>PAD.top+(high-value)/(high-low)*(H-PAD.top-PAD.bottom);
 const path=(list:typeof points)=>list.map((p,i)=>`${i?"L":"M"}${x(p.date).toFixed(1)},${y(p.balance).toFixed(1)}`).join("");
 const historyCount=plan.history.length,active=hover===null ? null : points[hover];
 function move(event:React.PointerEvent<SVGSVGElement>){
  const rect=box.current?.getBoundingClientRect();if(!rect)return;
  const at=(event.clientX-rect.left)/rect.width*W;let best=0;
  points.forEach((p,i)=>{if(Math.abs(x(p.date)-at)<Math.abs(x(points[best].date)-at))best=i;});setHover(best);
 }
 const summary=`${t("paydayChart")}: ${t("paydayToday")} ${money(plan.balance)}; ${t("paydayPayday")} ${date(plan.payday)} ${money(plan.forecast.at(-1)!.balance)}.`;
 return <figure className="space-y-2">
  <div className="relative">
   <svg ref={box} viewBox={`0 0 ${W} ${H}`} className="h-auto w-full touch-none text-brand" role="img" aria-label={summary} onPointerMove={move} onPointerLeave={()=>setHover(null)}>
    <line x1={PAD.left} x2={W-PAD.right} y1={y(0)} y2={y(0)} className="stroke-line" strokeWidth={1}/>
    <text x={W-PAD.right} y={y(0)-3} textAnchor="end" className="fill-ink-2 text-xs">{money(0)}</text>
    <line x1={x(plan.today)} x2={x(plan.today)} y1={PAD.top} y2={H-PAD.bottom} className="stroke-line" strokeWidth={1} strokeDasharray="2 3"/>
    <path d={path(points.slice(0,historyCount))} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round"/>
    <path d={path(points.slice(historyCount-1))} fill="none" stroke="currentColor" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round"/>
    {plan.bills.map(bill=>{const at=plan.forecast.find(p=>p.date===bill.date);return at ? <circle key={bill.date+bill.category+bill.amount} cx={x(at.date)} cy={y(at.balance)} r={4} className="fill-surface" stroke="currentColor" strokeWidth={2}/> : null;})}
    <text x={x(plan.today)} y={H-6} textAnchor="middle" className="fill-ink-2 text-xs">{t("paydayToday")}</text>
    <text x={x(plan.payday)} y={H-6} textAnchor="end" className="fill-ink-2 text-xs">{t("paydayPayday")}</text>
    {active && <><line x1={x(active.date)} x2={x(active.date)} y1={PAD.top} y2={H-PAD.bottom} className="stroke-ink-2" strokeWidth={1}/><circle cx={x(active.date)} cy={y(active.balance)} r={4} fill="currentColor" className="stroke-surface" strokeWidth={2}/></>}
   </svg>
   {active && <div role="status" className="pointer-events-none absolute top-0 rounded-md border border-line bg-surface px-2 py-1 text-xs shadow-sm" style={{left:`${Math.min(70,Math.max(0,x(active.date)/W*100-15))}%`}}><span className="block text-ink-2">{date(active.date)}</span><span className="font-semibold tabular-nums">{money(active.balance)}</span></div>}
  </div>
  <figcaption className="flex flex-wrap gap-4 text-xs text-ink-2"><span className="flex items-center gap-1"><svg aria-hidden="true" width="20" height="6" className="text-brand"><line x1="0" x2="20" y1="3" y2="3" stroke="currentColor" strokeWidth="2"/></svg>{t("paydayActual")}</span><span className="flex items-center gap-1"><svg aria-hidden="true" width="20" height="6" className="text-brand"><line x1="0" x2="20" y1="3" y2="3" stroke="currentColor" strokeWidth="2" strokeDasharray="5 4"/></svg>{t("paydayForecastLabel")}</span></figcaption>
 </figure>;
}
