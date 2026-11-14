"use client";
import {sourceCopyKey} from "@/engine/datasets";
import {useMoneyData} from "@/lib/money-data-context";
import {Info,X} from "lucide-react";
import {useState,useEffect,useRef} from "react";
import {useCopy} from "@/i18n/context";
import {records,lastMonth,type Period} from "@/engine";
import {date} from "@/lib/format";
import {Button} from "./ui/button";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "./ui/drawer";
export function BasisChip({period=lastMonth,count,assumption=false,label,confidence=false}:{period?:Period;count?:number;assumption?:boolean;label?:string;confidence?:boolean}) {
 const {data,dataset}=useMoneyData(),{t,locale}=useCopy(),through=new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10);
 const short=(value:string)=>new Intl.DateTimeFormat(locale,{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date(value+"T12:00:00Z"));
 return <Drawer><DrawerTrigger asChild><Button variant="ghost" size="chip" className={`max-w-full justify-start text-left text-sm text-ink-2 ${confidence ? "px-0" : ""}`} aria-label={t("basisTitle")}>{confidence && <span aria-hidden="true" className="size-2 rounded-full bg-ink-2"/>}{label??`${short(period.start)}–${short(through)} · ${t("partialChip")}`}<Info className="size-4 shrink-0"/></Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("basisTitle")}</DrawerTitle><DrawerDescription>{t("based",{start:date(period.start),end:date(through)})}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-4 overflow-y-auto px-4 text-sm"><p>{t("basisCount",{count:count??records(period,data).length})}</p><p>{t("partial")}</p>{assumption && <p>{t("assumption")}</p>}<p>{t("sourceSnapshot",{date:date(data.as_of)})}</p><p>{t(sourceCopyKey(dataset))}</p></div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>;
}
export function DataBanner() {
 const {t}=useCopy(),[dismissed,setDismissed]=useState(false),checked=useRef(false);
 useEffect(()=>{if(checked.current)return;checked.current=true;try{if(sessionStorage.getItem("money-coach-banner.v1"))setDismissed(true);else sessionStorage.setItem("money-coach-banner.v1","shown");}catch{}},[]);
 if(dismissed) return null;
 return <div className="flex items-center gap-2 rounded-xl bg-tile-grey pl-3 text-caption text-ink-2"><Info className="size-4 shrink-0"/><span className="flex-1">{t("dataBanner")}</span><Button variant="ghost" size="icon" aria-label={t("dismiss")} onClick={()=>setDismissed(true)}><X className="size-4"/></Button></div>;
}

