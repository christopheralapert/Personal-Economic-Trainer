import {tool,type InferUITools,type UIMessage} from "ai";
import {z} from "zod";
import {basisPointAmount,benchmark,calendarMonthPeriodSchema,demo,monthPeriod,monthlyAverages,periodSchema,reviewReasonSchema,safeToSpend,simulateReduction,spendByBasket,spendByCategory,spenderProfile,summary,transactionFiltersSchema,transactionStatusFilterSchema} from "@/engine";
import {historyPageSchema,transactionPage} from "@/engine/history";
import {sourceDate} from "@/engine/source-date";
import {peerComparison,peerMetricSchema,peerResultSchema} from "@/engine/peer-comparison";
const minor=z.number().int().safe();
export const groupSchema=z.object({key:z.string(),amount:minor,gross:minor.nonnegative(),refunds:minor.nonnegative(),count:z.number().int().nonnegative()});
const reductionSchema=z.object({category:z.string(),pct:z.number(),baseline:minor,monthly:minor,annual:minor,incomeShare:z.number().nullable(),period:calendarMonthPeriodSchema,observed:z.boolean()});
const safeSchema=z.object({status:z.literal("review_required"),amount:z.null(),reasons:z.array(reviewReasonSchema).min(2).max(6),balance:minor.nullable(),regular:minor.nonnegative(),irregular:minor.nonnegative(),buffer:minor.nonnegative(),savings:minor.nonnegative().nullable(),savingsPercent:z.number().int().min(0).max(100),illustrativeHeadroom:minor.nonnegative().nullable(),realizedIncome:minor.nonnegative(),asOf:z.iso.date(),sourceAsOf:z.iso.datetime({offset:true}),stale:z.boolean(),coverage:z.literal("partial")}).superRefine((value,ctx)=>{
  const reasons=new Set(value.reasons);
  const protectedAmount=BigInt(value.regular)+BigInt(value.irregular)+BigInt(value.buffer)+BigInt(value.savings ?? 0);
  const remainder=value.balance===null ? null : BigInt(value.balance)-protectedAmount;
  const expected=remainder===null ? null : remainder>0n ? remainder : 0n;
  if(reasons.size!==value.reasons.length || !reasons.has("history_incomplete") || !reasons.has("schedule_unreviewed")
    || reasons.has("balances_missing")!==(value.balance===null) || reasons.has("income_missing")!==(value.savings===null)
    || reasons.has("date_mismatch")!==value.stale || value.stale!==(value.asOf!==sourceDate(value.sourceAsOf))
    || value.savings!==(value.realizedIncome>0 ? basisPointAmount(value.realizedIncome,value.savingsPercent*100) : null)
    || (reasons.has("balances_outdated") && value.balance===null)
    || (value.illustrativeHeadroom===null ? expected!==null : BigInt(value.illustrativeHeadroom)!==expected))
    ctx.addIssue({code:"custom",message:"Inconsistent review evidence"});
});
export const propsSchemas={
  peerComparison:z.object({result:peerResultSchema}),
  showDonut:z.object({period:periodSchema,groups:z.array(groupSchema)}),
  showSummary:z.object({income:minor.nullable(),savings:minor.nullable(),expenses:minor.nullable()}),
  showTicks:z.object({groups:z.array(groupSchema)}),showBaskets:z.object({period:periodSchema,groups:z.array(groupSchema)}),
  showCategories:z.object({period:periodSchema,groups:z.array(groupSchema)}),showTransactions:historyPageSchema.safeExtend({period:periodSchema,filters:transactionFiltersSchema}),
  showSafeToSpend:z.object({purpose:z.enum(["spend","save"]),result:safeSchema}),
  showWhatIf:z.object({category:z.string(),initialPct:z.number().min(0).max(100),period:calendarMonthPeriodSchema,result:reductionSchema}),
  showProfile:z.object({result:z.object({type:z.enum(["observed_pattern","insufficient"]),leading:groupSchema.nullable(),leadingGrossShare:z.number().min(0).max(100).nullable(),baskets:z.array(groupSchema),total:minor,count:z.number().int(),period:periodSchema,coverage:z.literal("partial")})}),
  showBenchmark:z.object({result:z.object({category:z.string(),you:minor.nullable(),typical:minor.nullable(),reference:z.object({category:z.string(),annual:minor.nullable(),year:z.number().int(),source:z.url(),household:z.string()}).nullable(),comparable:z.literal(false),approximate:z.literal(true),period:calendarMonthPeriodSchema})}),
  showConcept:z.object({concept:z.enum(["fund","cashflow","habit","basketConcept","safeConcept","savingConcept","regular","irregular","everyday"])}),
  showInfo:z.object({}),showDetails:z.object({period:periodSchema,groups:z.array(groupSchema)}),showFilter:historyPageSchema.safeExtend({value:transactionStatusFilterSchema,period:periodSchema,filters:transactionFiltersSchema}),showStepper:z.object({step:z.literal(1)}),
};
export function createComponentTools(savingsPercent=10,data:import("@/engine").Dataset=demo) {
  const previous=monthPeriod(sourceDate(data.as_of),-1);
  const periodInput=z.object({period:periodSchema.default(previous)}).strict();
  const monthlyInput=z.object({period:calendarMonthPeriodSchema.default(previous)}).strict();
  return {
    peerComparison:tool({description:"Compare a synthetic persona's scoped monthly spending with age-band/postal-prefix synthetic peers. Categories or the three baskets. Engine supplies median and interquartile range, not exact percentiles or advice. Returns no figures if comparable history is insufficient. No real-bank personal comparison.",inputSchema:periodInput.extend({metric:peerMetricSchema.default("dining")}).strict(),outputSchema:propsSchemas.peerComparison,execute:async({period,metric})=>({result:peerComparison(metric,period,data)})}),
    showDonut:tool({description:"Show recorded category expenses as an interactive ring with source period.",inputSchema:periodInput,outputSchema:propsSchemas.showDonut,execute:async({period})=>({period,groups:spendByCategory(period,data)})}),
    showSummary:tool({description:"Income, actual saving and net expense summary. Missing values stay null.",inputSchema:periodInput,outputSchema:propsSchemas.showSummary,execute:async({period})=>summary(period,data)}),
    showTicks:tool({description:"Show gross basket proportions as ticks.",inputSchema:periodInput,outputSchema:propsSchemas.showTicks,execute:async({period})=>({groups:spendByBasket(period,data)})}),
    showBaskets:tool({description:"Explain the three necessity/recurrence baskets with recorded net amounts.",inputSchema:periodInput,outputSchema:propsSchemas.showBaskets,execute:async({period})=>({period,groups:spendByBasket(period,data)})}),
    showCategories:tool({description:"List ALL category totals together, with refunds included. Has NO category or merchant filter. Never use for spending on a specific category or merchant; that requires showTransactions.",inputSchema:periodInput,outputSchema:propsSchemas.showCategories,execute:async({period})=>({period,groups:spendByCategory(period,data)})}),
    showTransactions:tool({description:"Answer spending AMOUNT questions for a specific category or merchant, and list the actual matching booked records with their period and filters. The engine netExpenses and financialCount cover all matches, including records not on this page. Rows are one bounded page. For example, taxi spending requires category taxi here. Intersect optional exact basket, exact category and literal case-insensitive merchant substring. Basket identifiers: mandatory_regular, mandatory_irregular, everyday, unresolved. Never substitute unfiltered showCategories.",inputSchema:periodInput.extend(transactionFiltersSchema.shape).strict(),outputSchema:propsSchemas.showTransactions,execute:async({period,...filters})=>({period,filters,...transactionPage(period,"booked",data,filters)})}),
    showSafeToSpend:tool({description:"Review spending or extra saving with the same protected funds and missing evidence. Use purpose save for safe-to-save questions, spend otherwise. A target reserve is not an actual saving or permission amount.",inputSchema:z.object({purpose:z.enum(["spend","save"]).default("spend")}).strict(),outputSchema:propsSchemas.showSafeToSpend,execute:async({purpose="spend"})=>({purpose,result:safeToSpend(sourceDate(data.as_of),data,savingsPercent)})}),
    showWhatIf:tool({description:"Exact historical calendar-month category reduction requiring positive recorded net expenses, not a future saving promise.",inputSchema:monthlyInput.extend({category:z.string().min(1).max(80),pct:z.number().min(0).max(100).multipleOf(.01)}).strict(),outputSchema:propsSchemas.showWhatIf,execute:async({period,category,pct})=>({category,initialPct:pct,period,result:simulateReduction(category,pct,period,data)})}),
    showProfile:tool({description:"Describe observed category facts without assigning a personality or score.",inputSchema:periodInput,outputSchema:propsSchemas.showProfile,execute:async({period})=>({result:spenderProfile(period,data)})}),
    showBenchmark:tool({description:"Calendar-month context against an approximate 2022 Statistics Finland reference when mapped; unavailable otherwise, not personal comparability.",inputSchema:monthlyInput.extend({category:z.string().min(1).max(80)}).strict(),outputSchema:propsSchemas.showBenchmark,execute:async({period,category})=>({result:benchmark(category,undefined,period,data)})}),
    showConcept:tool({description:"Short financial literacy explanation.",inputSchema:propsSchemas.showConcept.strict(),outputSchema:propsSchemas.showConcept,execute:async input=>input}),
    showInfo:tool({description:"Explain why balance is not spending room.",inputSchema:z.object({}).strict(),outputSchema:propsSchemas.showInfo,execute:async()=>({})}),
    showDetails:tool({description:"Offer explicit period controls alongside recorded category totals.",inputSchema:periodInput,outputSchema:propsSchemas.showDetails,execute:async({period})=>({period,groups:spendByCategory(period,data)})}),
    showFilter:tool({description:"Explore actual transaction history by all/booked/reserved/reversed status, source period, exact basket/category and literal case-insensitive merchant substring. Intersect all supplied filters. Reserved and reversed records do not change expense totals.",inputSchema:periodInput.extend({value:transactionStatusFilterSchema.default("all"),...transactionFiltersSchema.shape}).strict(),outputSchema:propsSchemas.showFilter,execute:async({period,value="all",...filters})=>({value,period,filters,...transactionPage(period,value,data,filters)})}),
    showStepper:tool({description:"Open the first step of a local savings goal, without moving money.",inputSchema:z.object({}).strict(),outputSchema:propsSchemas.showStepper,execute:async()=>({step:1 as const})}),
  };
}
export type ComponentTools=ReturnType<typeof createComponentTools>;
export type ToolName=keyof ComponentTools;
export type CoachMessage=UIMessage<unknown,Record<string,never>,InferUITools<ComponentTools>>;
export const tools=createComponentTools();
export const availableAverages=monthlyAverages(3);
