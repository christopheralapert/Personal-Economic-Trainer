"use client";
import {useMemo,useState} from "react";
import {ChevronRight} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {proactiveInsights} from "@/engine/insights";
import {transactionQuestion} from "@/coach/explore-question";
import {percent} from "@/lib/format";
import {categoryLabel} from "@/i18n/context";
import {Button} from "./ui/button";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose,DrawerBody} from "./ui/drawer";
const primary:Key[]=["qTaxi","qWhatif","qSafe","qDonut"],more:Key[]=["qPeers","qSave","qProfile","qCompare","qBaskets","qLearn"];

/** Coach empty state: greeting, four starting questions, and the rest in one sheet. */
export function QuestionGrid({onAsk}:{onAsk:(question:string)=>void}) {
 const {t,locale}=useCopy(),{data}=useMoneyData(),{period}=usePlanning(),[open,setOpen]=useState(false),insight=useMemo(()=>proactiveInsights(period,data)[0],[period,data]);
 const insightQuestion=insight?.kind==="share" && insight.category ? {label:t("insightQuestion",{category:categoryLabel(insight.category,t),share:percent(insight.share!)}),question:transactionQuestion(insight.period,{category:insight.category},locale)} : null;
 const extra=[...(insightQuestion ? [insightQuestion] : []),...more.map(key=>({label:t(key),question:t(key)}))];
 return <div className="space-y-6 pt-2">
  <div className="space-y-1"><h3 className="text-xl font-semibold">{t("helloCoach")}</h3><p className="text-sm text-ink-2">{t("chatIntro")}</p></div>
  <div className="grid grid-cols-2 gap-3">{primary.map(key=><Button key={key} variant="outline" className="h-auto min-h-16 justify-start whitespace-normal rounded-2xl px-4 py-3 text-left text-sm font-medium" onClick={()=>onAsk(t(key))}>{t(key)}</Button>)}</div>
  <Button variant="ghost" className="w-full justify-between rounded-2xl px-4" onClick={()=>setOpen(true)}>{t("moreQuestions")}<ChevronRight className="size-4" aria-hidden="true"/></Button>
  <Drawer open={open} onOpenChange={setOpen}><DrawerContent><DrawerHeader><DrawerTitle>{t("moreQuestions")}</DrawerTitle><DrawerDescription>{t("chatIntro")}</DrawerDescription></DrawerHeader>
   <DrawerBody><ul className="divide-y divide-line">{extra.map(item=><li key={item.label}><button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left" onClick={()=>{setOpen(false);if(item.question)onAsk(item.question);}}><span>{item.label}</span><ChevronRight className="size-4 shrink-0 text-ink-2" aria-hidden="true"/></button></li>)}</ul></DrawerBody>
   <DrawerFooter><DrawerClose asChild><Button variant="outline">{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
 </div>;
}
