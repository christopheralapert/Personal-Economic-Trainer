"use client";
import {basketPlanSchema,type BasketPlan} from "./basket-plan";
import {z} from "zod";
import {monthlyPlanSchema,type MonthlyPlan} from "./monthly-plan";
import {createContext,useContext,useEffect,useState,type ReactNode} from "react";
import {useMoneyData} from "./money-data-context";
import {defaultPeriod} from "@/engine/planning";
import type {Period} from "@/engine";
import {useCopy} from "@/i18n/context";
import {goalAmountMinor,goalAmountInput} from "./savings-goal";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter} from "@/components/ui/drawer";
const baseStorageKey="money-coach-planning.v1";
type Planning={basketPlan:BasketPlan|null;saveBasketPlan:(plan:BasketPlan)=>void;plans:MonthlyPlan[];savePlan:(plan:MonthlyPlan)=>void;period:Period;setPeriod:(period:Period)=>void;income:number|null;billsConfirmed:boolean;openIncome:()=>void;confirmBills:()=>void};
const Context=createContext<Planning>({basketPlan:null,saveBasketPlan:()=>{},plans:[],savePlan:()=>{},period:defaultPeriod(),setPeriod:()=>{},income:null,billsConfirmed:false,openIncome:()=>{},confirmBills:()=>{}});
export function PlanningProvider({children}:{children:ReactNode}) {
 const {dataset,source}=useMoneyData();
 // Initial lazy loading replaces the bundled fixture without changing the
 // requested manifest key. Planning must initialize from the loaded clock.
 return <DatasetPlanning key={`${dataset}/${source.as_of}`}>{children}</DatasetPlanning>;
}
function DatasetPlanning({children}:{children:ReactNode}) {
 const {data,dataset}=useMoneyData(),suffix=dataset==="starter"?"":"."+dataset;
 const storageKey=baseStorageKey+suffix,monthlyKey="money-coach-monthly-plans.v1"+suffix,basketKey="money-coach-basket-plan.v1"+suffix;
 const [basketPlan,setBasketPlan]=useState<BasketPlan|null>(null);
 const [plans,setPlans]=useState<MonthlyPlan[]>([]);
 const [period,setPeriod]=useState<Period>(()=>defaultPeriod(data));
 const {t}=useCopy(),[income,setIncome]=useState<number|null>(null),[billsConfirmed,setBillsConfirmed]=useState(false),[open,setOpen]=useState(false),[draft,setDraft]=useState(""),[error,setError]=useState(false),[ready,setReady]=useState(false);

 useEffect(()=>{try{const raw=localStorage.getItem(basketKey);if(raw && raw.length<2000)setBasketPlan(basketPlanSchema.parse(JSON.parse(raw)));}catch{}try{const raw=localStorage.getItem(monthlyKey);if(raw && raw.length<20000)setPlans(z.array(monthlyPlanSchema).max(10).parse(JSON.parse(raw)));}catch{}try {const value=JSON.parse(localStorage.getItem(storageKey)??"null");if(value && Number.isSafeInteger(value.income) && value.income>0 && value.income<=100000000) setIncome(value.income);if(value?.billsConfirmed===true) setBillsConfirmed(true);}catch{}setReady(true);},[storageKey,monthlyKey,basketKey]);
 useEffect(()=>{if(ready) try {localStorage.setItem(storageKey,JSON.stringify({income,billsConfirmed}));}catch{}},[income,billsConfirmed,ready,storageKey]);
 function savePlan(plan:MonthlyPlan){const checked=monthlyPlanSchema.parse(plan),next=[...plans.filter(item=>item.name.toLocaleLowerCase()!==checked.name.toLocaleLowerCase()),checked].slice(-10);setPlans(next);try{localStorage.setItem(monthlyKey,JSON.stringify(next));}catch{}}
 function saveBasketPlan(plan:BasketPlan){const checked=basketPlanSchema.parse(plan);setBasketPlan(checked);try{localStorage.setItem(basketKey,JSON.stringify(checked));}catch{}}
 return <Context value={{basketPlan,saveBasketPlan,plans,savePlan,period,setPeriod,income,billsConfirmed,openIncome:()=>{setDraft(income===null ? "" : goalAmountInput(income));setError(false);setOpen(true);},confirmBills:()=>setBillsConfirmed(true)}}>{children}<Drawer open={open} onOpenChange={setOpen}><DrawerContent><DrawerHeader><DrawerTitle>{t("addIncome")}</DrawerTitle><DrawerDescription>{t("estimateNote")}</DrawerDescription></DrawerHeader><form onSubmit={event=>{event.preventDefault();const amount=goalAmountMinor(draft);if(amount===null || amount>100000000){setError(true);return;}setIncome(amount);setOpen(false);}}><div className="space-y-3 px-4"><label className="block space-y-2"><span>{t("monthlyIncome")}</span><Input inputMode="decimal" value={draft} maxLength={12} aria-invalid={error} aria-describedby={error ? "income-error" : undefined} onChange={event=>setDraft(event.target.value)}/></label>{error && <p id="income-error" role="alert" className="text-sm text-neg">{t("incomeError")}</p>}</div><DrawerFooter><Button>{t("saveEstimate")}</Button></DrawerFooter></form></DrawerContent></Drawer></Context>;
}
export function usePlanning(){return useContext(Context);}
