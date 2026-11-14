import {z} from "zod";
import {demo,analyzePeriod,type PeriodAnalysis,monthPeriod,calendarMonthPeriodSchema,reductionFromAnalysis,exactSum,type Dataset,type Period} from "./index";
import {sourceDate} from "./source-date";

export function scenarioMonths(data:Dataset=demo):Period[] {
  const end=new Date(sourceDate(data.as_of)+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);
  const through=end.toISOString().slice(0,10);
  const months=new Map<string,Period>();
  // Do not pass a multi-year period through the bounded interactive period schema.
  const included=new Set(data.accounts.filter(account=>account.included).map(account=>account.id));
  for(const row of data.transactions) if(included.has(row.account_id) && row.status==="booked" && row.booked_on<through && (row.economic_flow==="expense" || row.economic_flow==="refund")) {
    const month=monthPeriod(row.booked_on);if(month.end<=through) months.set(month.start,month);
  }
  return [...months.values()].sort((a,b)=>b.start.localeCompare(a.start));
}
function eligibleCategories(analysis:PeriodAnalysis) {
  const excluded=new Set(analysis.nonEverydayCategories);
  return analysis.categories.filter(group=>group.amount>0 && !excluded.has(group.key)).slice(0,4);
}
export function scenarioCategories(period:Period,data:Dataset=demo) {
  calendarMonthPeriodSchema.parse(period);
  return eligibleCategories(analyzePeriod(period,data));
}
export function combinedScenario(period:Period,percentages:Record<string,number>={},data:Dataset=demo) {
  calendarMonthPeriodSchema.parse(period);
  const analysis=analyzePeriod(period,data),categories=eligibleCategories(analysis);
  z.record(z.string(),z.number().min(0).max(100).multipleOf(.01)).parse(percentages);
  if(Object.keys(percentages).some(key=>!categories.some(group=>group.key===key))) throw new Error("Scenario category is outside the selected scope");
  const reductions=categories.map(group=>reductionFromAnalysis(group.key,Object.hasOwn(percentages,group.key) ? percentages[group.key] : 20,period,analysis));
  const monthly=reductions.length ? exactSum(reductions.map(result=>result.monthly)) : null;
  const income=analysis.income;
  return {categories,reductions,monthly,annual:monthly===null ? null : exactSum(Array(12).fill(monthly)),incomeShare:monthly!==null && income!==null && income>0 ? monthly/income*100 : null};
}
/** Pure repetition illustration, excluding starting savings and affordability. */
export function goalScenarioMonths(target:number,monthly:number|null):number|null {
  z.number().int().safe().positive().parse(target);z.number().int().safe().nonnegative().nullable().parse(monthly);
  return monthly===null || monthly===0 ? null : Number((BigInt(target)+BigInt(monthly)-1n)/BigInt(monthly));
}
