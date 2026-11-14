"use client";
import {useViewState} from "./view-state";
import {useMoneyData} from "./money-data-context";
import {propsSchemas,type ToolName} from "@/coach/catalog";
import {monthPeriod,periodSchema,simulateReduction,spendByCategory,type TransactionFilters,type TransactionStatusFilter} from "@/engine";
import {transactionPage} from "@/engine/history";
import {sourceDate} from "@/engine/source-date";

/** Read the same per-result selectors as the visible interactive component. */
export function useSpokenResult(name:ToolName|null,input:unknown,output:unknown) {
 const {data}=useMoneyData();
 const record=output && typeof output==="object" ? output as Record<string,unknown> : {};
 const parsedPeriod=periodSchema.safeParse(record.period);
 const initialPeriod=parsedPeriod.success ? parsedPeriod.data : monthPeriod(sourceDate(data.as_of));
 const category=typeof record.category==="string" ? record.category : "";
 const filter=name==="showFilter" ? propsSchemas.showFilter.safeParse(output) : null;
 const [period]=useViewState(name==="showFilter" ? "historyPeriod" : "period",initialPeriod);
 const [pct]=useViewState(`pct:${category}/${initialPeriod.start}/${initialPeriod.end}`,typeof record.initialPct==="number" ? record.initialPct : 20);
 const [status]=useViewState<TransactionStatusFilter>("status",filter?.success ? filter.data.value : "all");
 const [filters]=useViewState<TransactionFilters>("filters",filter?.success ? filter.data.filters : {});
 const [search]=useViewState("historySearch","");
 if(!name || !propsSchemas[name].safeParse(output).success)return null;
 const original=input && typeof input==="object" ? input as Record<string,unknown> : {};
 if(name==="showWhatIf") {
  const initial=propsSchemas.showWhatIf.parse(output);
  return {input:{...original,pct},output:{...initial,initialPct:pct,result:simulateReduction(initial.category,pct,initial.period,data)},speakable:true};
 }
 if(name==="showDonut" || name==="showDetails")return {input:{period},output:{period,groups:spendByCategory(period,data)},speakable:true};
 if(name==="showFilter")return {input:{period,value:status,...filters},output:{value:status,period,filters,...transactionPage(period,status,data,filters)},speakable:!search};
 return {input:original,output,speakable:true};
}
