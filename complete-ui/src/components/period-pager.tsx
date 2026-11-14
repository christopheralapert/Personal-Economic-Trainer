"use client";
import {useMoneyData} from "@/lib/money-data-context";
import {sourceDate} from "@/engine/source-date";
import {ChevronLeft,ChevronRight} from "lucide-react";
import {useCopy} from "@/i18n/context";
import {monthPeriod,type Period} from "@/engine";
import {Button} from "./ui/button";
export function PeriodPager({period,onChange,notice=false}:{period:Period;onChange:(period:Period)=>void;notice?:boolean}) {
 const {data}=useMoneyData(),snapshot=sourceDate(data.as_of);
 const {t,locale}=useCopy(),current=monthPeriod(snapshot),end=new Date(snapshot+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);
 const soFar={start:current.start,end:end.toISOString().slice(0,10)},title=new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"));
 return <div className="space-y-2"><div className="flex items-center justify-between gap-2"><Button type="button" variant="ghost" size="icon" aria-label={t("previousPeriod")} onClick={()=>onChange(monthPeriod(period.start,-1))}><ChevronLeft className="size-5"/></Button><p aria-live="polite" className="min-w-0 text-center font-semibold">{title}</p><Button type="button" variant="ghost" size="icon" aria-label={t("nextPeriod")} disabled={period.start>=current.start} onClick={()=>{const next=monthPeriod(period.start,1);onChange(next.start===current.start ? soFar : next);}}><ChevronRight className="size-5"/></Button></div>{period.start!==current.start && <div className="text-caption text-ink-2">{notice && <p>{t("periodNotice")}</p>}<Button type="button" variant="link" size="chip" className="h-auto min-h-12 max-w-full whitespace-normal" onClick={()=>onChange(soFar)}>{t("switchCurrent",{month:new Intl.DateTimeFormat(locale,{month:"long",timeZone:"UTC"}).format(new Date(snapshot+"T12:00:00Z"))})}</Button></div>}</div>;
}
