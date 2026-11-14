"use client";
import {useMemo,useState,useId} from "react";
import {useCopy} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {matchingMonths,questionForMonth} from "@/coach/month-recovery";
import type {QuestionContext} from "@/coach/question-context";
import {isCalendarMonth} from "@/engine";
import {Button} from "./ui/button";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter} from "./ui/drawer";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";
export function AnswerMonthChoice({context,onAsk,busy}:{context:QuestionContext;onAsk:(question:string)=>void;busy:boolean}) {
 const {data}=useMoneyData(),{setPeriod}=usePlanning(),{t,locale}=useCopy(),[open,setOpen]=useState(false),[selected,setSelected]=useState(""),id=useId();
 const months=useMemo(()=>matchingMonths(context,data),[context,data]);
 return <section className="space-y-3"><p className="text-sm text-ink-2">{t(months.length ? "chooseAnswerMonthNote" : "noMatchingMonths")}</p>{months.length>0 && <Drawer open={open} onOpenChange={setOpen}><DrawerTrigger asChild><Button variant="outline" disabled={busy}>{t("chooseAnswerMonth")}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{t("chooseAnswerMonth")}</DrawerTitle><DrawerDescription>{t("matchingMonths")}</DrawerDescription></DrawerHeader><div className="max-h-80 overflow-y-auto px-4"><RadioGroup value={selected} onValueChange={setSelected} aria-label={t("matchingMonths")}>{months.map((month,index)=><label key={month.start} htmlFor={`${id}-${index}`} className="flex min-h-14 items-center gap-3 border-b border-line py-3"><RadioGroupItem id={`${id}-${index}`} value={month.start}/><span>{new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(month.start+"T12:00:00Z"))}{!isCalendarMonth(month) && <span className="block text-caption text-ink-2">{t("partialMonth")}</span>}</span></label>)}</RadioGroup></div><DrawerFooter><Button disabled={!selected || busy} onClick={()=>{const month=months.find(value=>value.start===selected);if(!month)return;const question=questionForMonth(context,month,locale);if(question){setPeriod(month);setOpen(false);onAsk(question);}}}>{t("apply")}</Button></DrawerFooter></DrawerContent></Drawer>}</section>;
}
