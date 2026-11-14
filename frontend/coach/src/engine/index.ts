import {z} from "zod";
import {dateSchema,basketSchema,loadTransactions,isLoadedSnapshot,type Dataset,type Transaction} from "./data";
import {sourceDate} from "./source-date";
import {visibleTransactions,periodTransactions} from "./transaction-index";
export {loadTransactions,basketSchema,type Basket,type Dataset,type Transaction} from "./data";

export const periodSchema=z.object({start:dateSchema,end:dateSchema}).refine(p=>{
  const days=(Date.parse(p.end)-Date.parse(p.start))/86400000;
  return days>0 && days<=366;
},{message:"Period must contain 1 to 366 booking days"});
export type Period=z.infer<typeof periodSchema>;
export type Group={key:string;amount:number;gross:number;refunds:number;count:number};
export const demo=loadTransactions();
export const snapshot=sourceDate(demo.as_of);
export function monthPeriod(date:string,offset=0):Period {
  dateSchema.parse(date);const d=new Date(date+"T12:00:00Z");
  z.number().int().min(-1200).max(1200).parse(offset);
  const start=new Date(d);start.setUTCDate(1);start.setUTCMonth(start.getUTCMonth()+offset);
  const end=new Date(start);end.setUTCMonth(end.getUTCMonth()+1);
  return {start:start.toISOString().slice(0,10),end:end.toISOString().slice(0,10)};
}
export const lastMonth=monthPeriod(snapshot,-1);
export function isCalendarMonth(period:Period):boolean {
  if(!periodSchema.safeParse(period).success) return false;
  const calendar=monthPeriod(period.start);
  return calendar.start===period.start && calendar.end===period.end;
}
export const calendarMonthPeriodSchema=periodSchema.refine(isCalendarMonth,{message:"Monthly figures require one calendar month"});
export function exactSum(values:number[]):number {
  if(values.some(value=>!Number.isSafeInteger(value))) throw new Error("Unsafe minor-unit input");
  const sum=values.reduce((a,b)=>a+BigInt(b),0n);const result=Number(sum);
  if(!Number.isSafeInteger(result)) throw new Error("Amount overflow");return result;
}
/** Positive money times basis points, rounded half up with integer arithmetic. */
export function basisPointAmount(amount:number,bps:number):number {
  z.number().int().safe().nonnegative().parse(amount);z.number().int().min(0).max(10000).parse(bps);
  return Number((BigInt(amount)*BigInt(bps)+5000n)/10000n);
}
/** Inventory describes source coverage, never implies continuous history. */
export function sourceInventory(data:Dataset=demo) {
  const rows=visibleTransactions(data);
  let first:string|null=null,last:string|null=null;
  const statuses={booked:0,pending:0,reversed:0};
  for(const row of rows) {
    if(first===null || row.booked_on<first) first=row.booked_on;
    if(last===null || row.booked_on>last) last=row.booked_on;
    statuses[row.status]++;
  }
  return {count:rows.length,accounts:data.accounts.filter(account=>account.included).length,first,last,statuses,asOf:sourceDate(data.as_of),timezone:"Europe/Helsinki" as const};
}
export const transactionFiltersSchema=z.object({basket:basketSchema.optional(),category:z.string().min(1).max(80).optional(),merchant:z.string().min(1).max(120).optional()}).strict();
export type TransactionFilters=z.infer<typeof transactionFiltersSchema>;
export const transactionStatusFilterSchema=z.enum(["all","booked","reserved","reversed"]);
export type TransactionStatusFilter=z.infer<typeof transactionStatusFilterSchema>;
/** Read-only history may show reservations and reversals; analytics use records(). */
export function transactionHistory(period:Period,status:TransactionStatusFilter="all",data:Dataset=demo,filters:TransactionFilters={}):Transaction[] {
  periodSchema.parse(period);transactionStatusFilterSchema.parse(status);transactionFiltersSchema.parse(filters);
  const merchant=filters.merchant?.toLowerCase();
  return periodTransactions(data,period.start,period.end,(row,merchantName)=>(status==="all" || row.status===(status==="reserved" ? "pending" : status))
    && (filters.basket===undefined || row.basket===filters.basket)
    && (filters.category===undefined || row.category===filters.category)
    && (merchant===undefined || merchantName.includes(merchant)));
}
export function records(period:Period,data:Dataset=demo,filters:TransactionFilters={}):Transaction[] {
  return transactionHistory(period,"booked",data,filters);
}
/** One selected-record pass supplies all related period observations. Results are fresh values. */
function computePeriodAnalysis(period:Period,data:Dataset) {
  const categories=new Map<string,Group>(),baskets=new Map<string,Group>(),nonEveryday=new Set<string>();
  let income=0,incomeCount=0;
  const add=(groups:Map<string,Group>,key:string,row:Transaction)=>{
    const g=groups.get(key) ?? {key,amount:0,gross:0,refunds:0,count:0};
    if(row.economic_flow==="expense") g.gross=exactSum([g.gross,-row.amount_minor]);
    else g.refunds=exactSum([g.refunds,row.amount_minor]);
    g.amount=exactSum([g.gross,-g.refunds]);g.count++;groups.set(key,g);
  };
  for(const row of records(period,data)) {
    if(row.economic_flow==="income") {income=exactSum([income,row.amount_minor]);incomeCount++;}
    if(row.economic_flow!=="expense" && row.economic_flow!=="refund") continue;
    add(categories,row.category,row);add(baskets,row.basket,row);
    if(row.basket!=="everyday") nonEveryday.add(row.category);
  }
  const sorted=(groups:Map<string,Group>)=>[...groups.values()].sort((a,b)=>b.gross-a.gross || a.key.localeCompare(b.key));
  const categoryGroups=sorted(categories);
  return {period:{...period},categories:categoryGroups,baskets:sorted(baskets),nonEverydayCategories:[...nonEveryday],
    income:incomeCount ? income : null,expenses:categoryGroups.length ? exactSum(categoryGroups.map(g=>g.amount)) : null};
}
export type PeriodAnalysis=ReturnType<typeof computePeriodAnalysis>;
const periodCache=new WeakMap<Dataset,Map<string,PeriodAnalysis>>();
/** Cache only loader-owned immutable snapshots. Always return fresh values to protect subsequent readers. */
export function analyzePeriod(period:Period,data:Dataset=demo):PeriodAnalysis {
 periodSchema.parse(period);
 if(!isLoadedSnapshot(data))return computePeriodAnalysis(period,data);
 let entries=periodCache.get(data);if(!entries){entries=new Map();periodCache.set(data,entries);}
 const key=`${period.start}/${period.end}`;let result=entries.get(key);
 if(!result){result=computePeriodAnalysis(period,data);if(entries.size>=32)entries.delete(entries.keys().next().value!);entries.set(key,result);}
 return {...result,period:{...result.period},categories:result.categories.map(g=>({...g})),baskets:result.baskets.map(g=>({...g})),nonEverydayCategories:[...result.nonEverydayCategories]};
}
export function spendByCategory(period:Period,data:Dataset=demo) {return analyzePeriod(period,data).categories;}
export function spendByBasket(period:Period,data:Dataset=demo) {return analyzePeriod(period,data).baskets;}
export function summary(period:Period,data:Dataset=demo) {
  const result=analyzePeriod(period,data);
  return {income:result.income,expenses:result.expenses,savings:null as number|null};
}
/** Read-only synthetic source inventory; this is never spending permission. */
export function bankSummaries(data:Dataset=demo) {
  const groups=new Map<string,Dataset["accounts"]>();
  for(const account of data.accounts.filter(a=>a.included)) {
    const id=account.institution_id ?? account.id;
    const existing=groups.get(id);if(existing) existing.push(account);else groups.set(id,[account]);
  }
  const observed=new Map<string,Dataset["balances"]>();
  for(const balance of data.balances) if(Date.parse(balance.observed_at)<=Date.parse(data.as_of)) {
    const existing=observed.get(balance.account_id);if(existing) existing.push(balance);else observed.set(balance.account_id,[balance]);
  }
  return [...groups].map(([id,accounts])=>{
    const names=new Set(accounts.map(a=>a.name).filter((name):name is string=>Boolean(name)));
    const balances=accounts.map(a=>observed.get(a.id) ?? []);
    return {id,name:names.size===1 ? [...names][0] : null,accountCount:accounts.length,
      balance:balances.every(values=>values.length===1) ? exactSum(balances.map(([b])=>exactSum([b.amount_minor,-b.included_credit_minor]))) : null};
  });
}
export function monthlyAverages(n:number,data:Dataset=demo) {
  z.number().int().min(1).max(12).parse(n);
  const months=Array.from({length:n},(_,i)=>summary(monthPeriod(sourceDate(data.as_of),-i-1),data));
  return {months:n,observedExpenseMonths:months.filter(month=>month.expenses!==null).length,
    expenses:months.every(month=>month.expenses!==null) ? Math.round(exactSum(months.map(m=>m.expenses!))/n) : null,
    income:months.every(m=>m.income!==null) ? Math.round(exactSum(months.map(m=>m.income!))/n) : null,
    start:monthPeriod(sourceDate(data.as_of),-n).start,end:monthPeriod(sourceDate(data.as_of),0).start,coverage:"partial" as const};
}
export const reviewReasonSchema=z.enum(["history_incomplete","schedule_unreviewed","balances_missing","income_missing","date_mismatch","balances_outdated"]);
export type ReviewReason=z.infer<typeof reviewReasonSchema>;
export function safeToSpend(today:string,data:Dataset=demo,savingsPercent=10) {
  dateSchema.parse(today);z.number().int().min(0).max(100).parse(savingsPercent);
  const included=data.accounts.filter(account=>account.included);
  const cutoff=Date.parse(data.as_of);
  const observed=new Map<string,Dataset["balances"]>();
  for(const row of data.balances) if(Date.parse(row.observed_at)<=cutoff && sourceDate(row.observed_at)<=today){const group=observed.get(row.account_id);if(group) group.push(row);else observed.set(row.account_id,[row]);}
  const balances=included.map(account=>observed.get(account.id) ?? []);
  const balance=included.length>0 && balances.every(group=>group.length===1)
    ? exactSum(balances.map(([row])=>exactSum([row.amount_minor,-row.included_credit_minor]))) : null;
  const realizedIncome=exactSum(records(monthPeriod(today),data).filter(t=>t.economic_flow==="income" && t.booked_on<=today).map(t=>t.amount_minor));
  const savings=realizedIncome>0 ? basisPointAmount(realizedIncome,savingsPercent*100) : null;
  const costs=exactSum([data.bills_minor,data.essentials_minor,data.buffer_minor,savings ?? 0]);
  const reasons:ReviewReason[]=["history_incomplete","schedule_unreviewed"];
  if(balance===null) reasons.push("balances_missing");
  if(savings===null) reasons.push("income_missing");
  if(today!==sourceDate(data.as_of)) reasons.push("date_mismatch");
  if(balance!==null && balances.some(group=>sourceDate(group[0].observed_at)!==today)) reasons.push("balances_outdated");
  // No future-income projection or monthly proration grants spendable money.
  // The supplied fixture has no complete history, reviewed schedule or income coverage.
  return {status:"review_required" as const,amount:null,reasons,balance,regular:data.bills_minor,
    irregular:data.essentials_minor,buffer:data.buffer_minor,savings,savingsPercent,
    illustrativeHeadroom:balance===null ? null : Math.max(0,exactSum([balance,-costs])),realizedIncome,asOf:today,sourceAsOf:data.as_of,
    stale:today!==sourceDate(data.as_of),coverage:"partial" as const};
}
export class UnavailableScenarioError extends Error {
  constructor() {super("A positive recorded net-expense baseline is required");this.name="UnavailableScenarioError";}
}
export function simulateReduction(category:string,pct:number,period:Period=lastMonth,data:Dataset=demo) {
  calendarMonthPeriodSchema.parse(period);
  z.number().min(0).max(100).multipleOf(0.01).parse(pct);
  return reductionFromAnalysis(category,pct,period,analyzePeriod(period,data));
}
/** Internal composition helper: only pass observations produced by analyzePeriod. */
export function reductionFromAnalysis(category:string,pct:number,period:Period,analysis:PeriodAnalysis) {
  calendarMonthPeriodSchema.parse(period);z.number().min(0).max(100).multipleOf(.01).parse(pct);
  if(analysis.period.start!==period.start || analysis.period.end!==period.end) throw new Error("Analysis period mismatch");
  const row=analysis.categories.find(g=>g.key===category);
  if(!row || row.gross<=0 || row.amount<=0) throw new UnavailableScenarioError();
  const baseline=row.amount,bps=Math.round(pct*100);
  const reduction=basisPointAmount(baseline,bps);
  const income=analysis.income;
  return {category,pct,baseline,monthly:reduction,annual:exactSum(Array(12).fill(reduction)),
    incomeShare:income && income>0 ? reduction/income*100 : null,period,observed:!!row};
}
export function spenderProfile(period:Period=lastMonth,data:Dataset=demo) {
  const {categories,baskets}=analyzePeriod(period,data);
  const leading=categories.find(group=>group.gross>0) ?? null,gross=exactSum(categories.map(group=>group.gross));
  return {type:leading ? "observed_pattern" as const : "insufficient" as const,
    leading,leadingGrossShare:leading && gross>0 ? leading.gross/gross*100 : null,baskets,total:exactSum(categories.map(g=>g.amount)),
    count:exactSum(categories.map(g=>g.count)),period,coverage:"partial" as const};
}
export type PopulationReference={category:string;annual:number|null;year:number;source:string;household:string};
export interface BenchmarkSource {get(category:string):PopulationReference|null}
// Offline reference adapter. Only a semantically mapped category is eligible.
export function benchmark(category:string,source:BenchmarkSource=populationReference,period:Period=lastMonth,data:Dataset=demo) {
  calendarMonthPeriodSchema.parse(period);
  const ref=source.get(category),you=spendByCategory(period,data).find(g=>g.key===category)?.amount ?? null;
  return {category,you,typical:ref?.annual===null || !ref ? null : Math.round(ref.annual/12),reference:ref,
    comparable:false,approximate:true,period};
}
import population from "../../data/population.json";
export const populationReference:BenchmarkSource={get:category=>population.find(row=>row.category===category) ?? null};
