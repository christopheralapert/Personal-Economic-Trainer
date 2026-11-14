"use client";
import {useMemo,useState} from "react";
import {useCopy,type Key} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {usePlanning} from "@/lib/planning-context";
import {proactiveInsights} from "@/engine/insights";
import {transactionQuestion} from "@/coach/explore-question";
import {percent} from "@/lib/format";
import {categoryLabel} from "@/i18n/context";
import {Button} from "./ui/button";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "./ui/drawer";
const primary:Key[]=["qTaxi","qWhatif","qSafe","qDonut"],more:Key[]=["qPeers","qSave","qProfile","qCompare","qBaskets","qLearn"];
export function QuestionGrid({onAsk}:{onAsk:(question:string)=>void}) {
 const {t,locale}=useCopy(),{data}=useMoneyData(),{period}=usePlanning(),[open,setOpen]=useState(false),insight=useMemo(()=>proactiveInsights(period,data)[0],[period,data]);const question=insight ? transactionQuestion(insight.period,insight.category ? {category:insight.category} : {},locale) : null;
 return <div className="space-y-4 py-5"><h3 className="text-2xl font-bold">{t("helloCoach")}</h3><p className="text-sm text-ink-2">{t("chatIntro")}</p><div className="grid grid-cols-2 gap-3">{primary.map(key=><Button key={key} variant="outline" size="chip" className="h-auto min-h-14 justify-start text-left" onClick={()=>onAsk(t(key))}>{t(key)}</Button>)}</div>{insight?.kind==="share" && question && <Button variant="outline" size="chip" className="h-auto text-left" onClick={()=>onAsk(question)}>{t("insightQuestion",{category:categoryLabel(insight.category!,t),share:percent(insight.share!)})}</Button>}<Button variant="ghost" size="chip" onClick={()=>setOpen(true)}>{t("moreQuestions")}</Button><Drawer open={open} onOpenChange={setOpen}><DrawerContent><DrawerHeader><DrawerTitle>{t("moreQuestions")}</DrawerTitle><DrawerDescription>{t("chatIntro")}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-2 overflow-y-auto px-4">{more.map(key=><Button key={key} variant="outline" className="h-auto min-h-12 w-full text-left" onClick={()=>{setOpen(false);onAsk(t(key));}}>{t(key)}</Button>)}</div><DrawerFooter><DrawerClose asChild><Button variant="outline">{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer></div>;
}
