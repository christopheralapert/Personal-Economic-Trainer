"use client";
import {CalendarDays} from "lucide-react";
import {useMoneyData} from "@/lib/money-data-context";
import {sourceDate} from "@/engine/source-date";
import {PeriodPager} from "../period-pager";
import {usePlanning} from "@/lib/planning-context";
import {useId,useState} from "react";

import {useCopy} from "@/i18n/context";
import {type Period} from "@/engine";
import {inclusiveThrough,periodFromDates,periodPreset} from "@/lib/period-input";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription} from "@/components/ui/drawer";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";

export function PeriodSheet({period,onChange}:{period:Period;onChange?:(p:Period)=>void}) {
  const {data}=useMoneyData(),snapshot=sourceDate(data.as_of);
  const through=inclusiveThrough(period.end),global=usePlanning();
  const {t}=useCopy(),id=useId(),[open,setOpen]=useState(false),[start,setStart]=useState(period.start),[end,setEnd]=useState(through),[error,setError]=useState<"invalid"|"future"|null>(null);
  function preset(kind:"previous"|"snapshot"){const next=periodPreset(kind,snapshot);setStart(next.start);setEnd(inclusiveThrough(next.end));setError(null);}
  return <Drawer open={open} onOpenChange={next=>{if(next){setStart(period.start);setEnd(through);setError(null);}setOpen(next);}}>
    <DrawerTrigger asChild><Button variant="outline" size="chip" className="gap-2"><CalendarDays className="size-4" aria-hidden="true"/>{t("choosePeriod")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("choosePeriod")}</DrawerTitle><DrawerDescription>{t("rowsNote")}</DrawerDescription></DrawerHeader><div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"><form noValidate className="space-y-4 pt-5" onSubmit={event=>{event.preventDefault();const result=periodFromDates(start,end,snapshot);setError(result.ok ? null : result.reason);if(result.ok){onChange?.(result.period);global.setPeriod(result.period);setOpen(false);}}}>
      <PeriodPager period={periodFromDates(start,end,snapshot).ok ? {start,end:new Date(Date.parse(end+"T12:00:00Z")+86400000).toISOString().slice(0,10)} : period} onChange={value=>{setStart(value.start);setEnd(inclusiveThrough(value.end));}}/><div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="chip" onClick={()=>preset("previous")}>{t("previousPeriod")}</Button><Button type="button" variant="outline" size="chip" onClick={()=>preset("snapshot")}>{t("snapshotPeriod")}</Button></div>
      <label className="block space-y-2" htmlFor={`${id}-start`}><span className="text-sm">{t("from")}</span><Input id={`${id}-start`} type="date" required max={snapshot} value={start} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event=>{setStart(event.target.value);setError(null);}}/></label>
      <label className="block space-y-2" htmlFor={`${id}-end`}><span className="text-sm">{t("through")}</span><Input id={`${id}-end`} type="date" required max={snapshot} value={end} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event=>{setEnd(event.target.value);setError(null);}}/></label>
      {error && <p id={`${id}-error`} className="text-sm text-neg" role="alert">{t(error==="future" ? "futurePeriod" : "invalidPeriod")}</p>}<Button type="submit" className="w-full">{t("apply")}</Button>
    </form></div></DrawerContent>
  </Drawer>;
}
