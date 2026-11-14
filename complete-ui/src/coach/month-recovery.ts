import {propsSchemas,type CoachMessage,type ToolName} from "./catalog";
import {interpretQuestion,requestForIntent} from "./intent";
import {questionContextSchema,type QuestionContext} from "./question-context";
import {monthPeriod,isCalendarMonth,simulateReduction,snapshot,type Dataset,type Period,type TransactionFilters} from "@/engine";
import {visibleTransactions} from "@/engine/transaction-index";
import {sourceDate} from "@/engine/source-date";
import {transactionQuestion} from "./explore-question";
import {translate} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";

export function monthRecovery(message:CoachMessage,question:string,selected:Period,referenceDate=snapshot):QuestionContext|null {
 for(const part of message.parts) {
  if(!part.type.startsWith("tool-") || !("state" in part) || part.state!=="output-available" || !("input" in part))continue;
  const tool=part.type.slice(5) as ToolName,checked=propsSchemas[tool]?.safeParse(part.output);if(!checked?.success)continue;
  const output=checked.data;
  const empty="total" in output ? output.total===0 : "groups" in output ? output.groups.length===0 : "result" in output && "count" in output.result ? output.result.count===0 : false;
  if(empty){const context=questionContextSchema.safeParse({tool,input:part.input});if(context.success)return context.data;}
 }
 const intent=interpretQuestion(question,selected,referenceDate);
 if(intent.status==="ready" && intent.tool==="showWhatIf" && !message.parts.some(part=>part.type.startsWith("tool-"))){const request=requestForIntent(intent),context=questionContextSchema.safeParse({tool:request.name,input:request.input});if(context.success)return context.data;}
 if(intent.status!=="ready" && intent.retryQuestion){const retry=interpretQuestion(intent.retryQuestion,undefined,referenceDate);if(retry.status==="ready"){const request=requestForIntent(retry),context=questionContextSchema.safeParse({tool:request.name,input:request.input});if(context.success)return context.data;}}
 return null;
}

/** Only months containing matching, visible source rows are offered. No inferred coverage. */
export function matchingMonths(context:QuestionContext,data:Dataset):Period[] {
 const {tool,input}=context,filtered=tool==="showTransactions" || tool==="showFilter" || tool==="showWhatIf" || tool==="showBenchmark";
 const status=tool==="showFilter" ? input.value : "booked",keys=new Set<string>();
 for(const row of visibleTransactions(data)) {
  if(status!=="all" && row.status!==(status==="reserved" ? "pending" : status))continue;
  if(filtered && (typeof input.category==="string" && row.category!==input.category || typeof input.basket==="string" && row.basket!==input.basket || typeof input.merchant==="string" && !row.merchant.toLowerCase().includes(input.merchant.toLowerCase())))continue;
  keys.add(row.booked_on.slice(0,7));
 }
 const through=new Date(sourceDate(data.as_of)+"T12:00:00Z");through.setUTCDate(through.getUTCDate()+1);const cutoff=through.toISOString().slice(0,10);
 return [...keys].sort().reverse().map(key=>{const period=monthPeriod(key+"-01");return {...period,end:period.end>cutoff ? cutoff : period.end};}).filter(period=>{
  if(["showWhatIf","showBenchmark"].includes(tool) && !isCalendarMonth(period))return false;
  if(tool==="showWhatIf"){try{simulateReduction(input.category as string,input.pct as number,period,data);}catch{return false;}}
  return true;
 }).slice(0,24);
}

export function questionForMonth(context:QuestionContext,period:Period,locale:Locale):string|null {
 const {tool,input}=context;
 const through=new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10),suffix=translate(locale,"queryPeriod",{start:period.start,end:through});
 if(tool==="showTransactions")return transactionQuestion(period,{...(typeof input.category==="string" ? {category:input.category} : {}),...(typeof input.merchant==="string" ? {merchant:input.merchant} : {}),...(typeof input.basket==="string" ? {basket:input.basket as TransactionFilters["basket"]} : {})},locale);
 // Serialized commands preserve every validated selector; English is the shared tool grammar.
 if(tool==="showFilter") {const base=transactionQuestion(period,{...(typeof input.category==="string" ? {category:input.category} : {}),...(typeof input.merchant==="string" ? {merchant:input.merchant} : {}),...(typeof input.basket==="string" ? {basket:input.basket as TransactionFilters["basket"]} : {})},locale);return base?.replace(translate(locale,"queryTransactions"),translate(locale,({all:"retryStatusAll",booked:"retryStatusBooked",reserved:"retryStatusReserved",reversed:"retryStatusReversed"} as const)[input.value as "all"|"booked"|"reserved"|"reversed"]))??null;}
 if(tool==="showWhatIf")return `${translate(locale,"retryReduction",{category:JSON.stringify(input.category),pct:String(input.pct)})} ${suffix}`;
 const prefix={showDonut:"retryOverview",showCategories:"retrySpending",showBaskets:"qBaskets",showProfile:"qProfile",showDetails:"retryDetails",showBenchmark:"retryBenchmark"} as const;
 if(!(tool in prefix))return null;
 return `${translate(locale,prefix[tool as keyof typeof prefix],{category:JSON.stringify(input.category)}).replace(/\?$/u,"")} ${suffix}`;
}
