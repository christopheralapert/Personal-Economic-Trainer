"use client";
import {useMoneyData} from "@/lib/money-data-context";
import {useEffect,useState} from "react";
import Link from "next/link";
import {useRouter} from "next/navigation";
import {createComponentTools,type ToolName} from "@/coach/catalog";
import {transactionPage} from "@/engine/history";
import {lastMonth} from "@/engine";
import {useCopy} from "@/i18n/context";
import {GeneratedComponent} from "@/components/gen/registry";
const names:ToolName[]=["showDonut","showSummary","showTicks","showBaskets","showCategories","showTransactions","showSafeToSpend","showWhatIf","showProfile","showBenchmark","showConcept","showInfo","showDetails","showFilter","showStepper"];
export default function Kit() {
  const {data}=useMoneyData(),{t}=useCopy(),router=useRouter(),[outputs,setOutputs]=useState<Record<string,unknown>>({});
  useEffect(()=>{let active=true;const tools=createComponentTools(10,data);void Promise.all(names.map(async name=>{
    const input=name==="showWhatIf" ? {period:lastMonth,category:"dining",pct:20} : name==="showBenchmark" ? {period:lastMonth,category:"taxi"} : name==="showConcept" ? {concept:"fund"} : {period:lastMonth};
    const execute=tools[name].execute as (input:unknown,options:unknown)=>Promise<unknown>;
    let output:unknown;try{output=await execute(input,{toolCallId:name,messages:[]});}catch{output=undefined;}
    return [name,name==="showTransactions" ? {...output as object,...transactionPage(lastMonth,"booked",data,{},0,5)} : output] as const;
  })).then(values=>{if(active) setOutputs(Object.fromEntries(values));});return ()=>{active=false;};},[data]);
  return <main className="mx-auto min-h-dvh max-w-app space-y-6 bg-surface px-4 py-6"><Link href="/" className="inline-flex min-h-12 items-center text-brand underline">{t("back")}</Link><h1 className="text-xl font-bold">{t("kit")}</h1><p className="text-sm text-ink-2">{t("kitNote")}</p>{names.map(name=><section key={name} className="space-y-4 border-t border-line pt-6" data-component={name}><h2 className="text-base font-bold">{name}</h2>{outputs[name]!==undefined && <GeneratedComponent name={name} output={outputs[name]} onGoal={()=>router.push("/?goal=1")} onAsk={question=>{router.push(`/?question=${encodeURIComponent(question)}`);}}/>}</section>)}</main>;
}
