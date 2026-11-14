"use client";
import {useState} from "react";
import {useCopy} from "@/i18n/context";
import {usePlanning} from "@/lib/planning-context";
import {money} from "@/lib/format";
import {Button} from "./ui/button";
import {Input} from "./ui/input";
import {Progress} from "./ui/progress";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "./ui/drawer";
export function MonthlyPlanSheet({amount,onClose}:{amount:number;onClose:()=>void}) {
 const {t}=useCopy(),{savePlan}=usePlanning(),[name,setName]=useState(t("goalPlaceholder"));
 return <Drawer open onOpenChange={open=>{if(!open)onClose();}}><DrawerContent><DrawerHeader><DrawerTitle>{t("setAside",{amount:money(amount)})}</DrawerTitle><DrawerDescription>{t("planNotMoved")}</DrawerDescription></DrawerHeader><form onSubmit={event=>{event.preventDefault();if(!name.trim())return;savePlan({id:crypto.randomUUID(),name:name.trim(),monthlyMinor:amount,targetMinor:amount*12,contributedMinor:null});onClose();}}><label className="block space-y-2 px-4"><span>{t("goalName")}</span><Input value={name} required maxLength={80} onChange={event=>setName(event.target.value)}/></label><p className="px-4 pt-4 text-sm text-ink-2">{t("yearlyPlan",{amount:money(amount*12)})}</p><DrawerFooter><Button disabled={!name.trim()}>{t("savePlan")}</Button><DrawerClose asChild><Button type="button" variant="outline">{t("close")}</Button></DrawerClose></DrawerFooter></form></DrawerContent></Drawer>;
}
export function MonthlyPlans() {
 const {t}=useCopy(),{plans}=usePlanning();
 if(!plans.length)return null;
 return <section aria-label={t("monthlyPlans")} className="space-y-3">{plans.map(plan=><div key={plan.id} className="space-y-3 rounded-3xl bg-tile-saving p-4"><h3 className="wrap-anywhere font-semibold">{plan.name}</h3><p className="text-xl font-bold">{money(plan.monthlyMinor)} <span className="text-sm font-normal">{t("perMonth")}</span></p><p className="text-caption text-ink-2">{t("yearlyPlan",{amount:money(plan.targetMinor)})}</p><p className="text-caption text-ink-2">{t("recordedContribution")}: {plan.contributedMinor===null ? t("notTracked") : money(plan.contributedMinor)}</p>{plan.contributedMinor!==null && <Progress value={Math.min(100,plan.contributedMinor/plan.targetMinor*100)} aria-label={plan.name}/>}<p className="text-caption text-ink-2">{t("planNotMoved")}</p></div>)}</section>;
}
