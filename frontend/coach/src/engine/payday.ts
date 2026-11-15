import {z} from "zod";
import {demo,exactSum,monthPeriod,observedReserves,records,safeToSpend,spendByBasket,type Dataset} from "./index";
import {dateSchema} from "./data";
import {sourceDate} from "./source-date";

/**
 * Until-payday planning: what is left per day before the next salary after the bills
 * expected before it and a surprise buffer, an optional planned purchase and an optional
 * salary delay. Every input comes from recorded transactions; the result is an estimate.
 */
const day=86400000;
const addDays=(date:string,days:number)=>new Date(Date.parse(date+"T12:00:00Z")+days*day).toISOString().slice(0,10);
const between=(from:string,to:string)=>Math.round((Date.parse(to+"T12:00:00Z")-Date.parse(from+"T12:00:00Z"))/day);
/** The same day of month in the month `offset` months from `date`, clamped to that month's length. */
function dayInMonth(date:string,dayOfMonth:number,offset:number){
 const start=monthPeriod(date,offset).start,length=between(start,monthPeriod(date,offset).end);
 return addDays(start,Math.min(dayOfMonth,length)-1);
}
const median=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor((sorted.length-1)/2)];};
const payerKey=(row:Dataset["transactions"][number])=>`${row.account_id}/${row.merchant.replace(/\d{4}-\d{2}-\d{2}|\d+/gu,"").replace(/[\s/.,-]+$/u,"").trim().toLocaleLowerCase()}`;

/** The largest payer seen in at least three of the last four calendar months: typical day and amount. */
export function incomeSchedule(data:Dataset=demo,today=sourceDate(data.as_of)) {
 dateSchema.parse(today);
 const payers=new Map<string,Dataset["transactions"]>();
 for(const row of records({start:monthPeriod(today,-3).start,end:addDays(today,1)},data)) if(row.economic_flow==="income" && row.amount_minor>0) {
  const key=payerKey(row);payers.set(key,[...(payers.get(key)??[]),row]);
 }
 const candidates=[...payers.values()].filter(rows=>new Set(rows.map(row=>row.booked_on.slice(0,7))).size>=3).map(rows=>{
  const recent=[...rows].sort((a,b)=>a.booked_on.localeCompare(b.booked_on)).slice(-3);
  return {amount:median(recent.map(row=>row.amount_minor)),dayOfMonth:median(recent.map(row=>Number(row.booked_on.slice(8,10)))),lastPaid:recent[2].booked_on};
 }).sort((a,b)=>b.amount-a.amount);
 return candidates[0]??null;
}

export const paydayInputSchema=z.object({purchase_minor:z.number().int().min(0).max(10_000_000).optional(),delay_days:z.number().int().min(0).max(14).optional()}).strict();
const minor=z.number().int().safe();
const point=z.object({date:dateSchema,balance:minor});
export const paydayResultSchema=z.discriminatedUnion("status",[
 z.object({status:z.literal("unavailable"),reason:z.enum(["income","balance"]),today:dateSchema,purchase:minor.nonnegative(),delayDays:z.number().int().min(0).max(14)}),
 z.object({status:z.literal("ready"),today:dateSchema,payday:dateSchema,scheduledPayday:dateSchema,delayDays:z.number().int().min(0).max(14),days:z.number().int().min(1).max(60),
  balance:minor,income:minor.positive(),bills:z.array(z.object({date:dateSchema,category:z.string(),amount:minor.nonnegative()})).max(80),billsTotal:minor.nonnegative(),
  buffer:minor.nonnegative(),purchase:minor.nonnegative(),available:minor,perDay:minor.nonnegative(),usualPerDay:minor.nonnegative(),
  history:z.array(point).max(40),forecast:z.array(point).max(62),runsOutOn:dateSchema.nullable(),coverage:z.literal("partial")}),
]);
export type PaydayResult=z.infer<typeof paydayResultSchema>;

export function paydayForecast({data=demo,today=sourceDate(data.as_of),purchase=0,delayDays=0}:{data?:Dataset;today?:string;purchase?:number;delayDays?:number}={}):PaydayResult {
 dateSchema.parse(today);paydayInputSchema.parse({purchase_minor:purchase,delay_days:delayDays});
 const schedule=incomeSchedule(data,today);
 if(!schedule)return {status:"unavailable",reason:"income",today,purchase,delayDays};
 const review=safeToSpend(today,data);
 if(review.balance===null || review.reasons.some(reason=>reason==="balances_outdated" || reason==="date_mismatch"))return {status:"unavailable",reason:"balance",today,purchase,delayDays};
 let scheduledPayday=dayInMonth(today,schedule.dayOfMonth,0);
 if(scheduledPayday<=today)scheduledPayday=dayInMonth(today,schedule.dayOfMonth,1);
 const payday=addDays(scheduledPayday,delayDays),days=between(today,payday);
 // Regular must-pay bills from the last month, projected one month ahead, that fall before payday.
 const bills=records({start:addDays(today,-30),end:addDays(today,1)},data).filter(row=>row.basket==="mandatory_regular" && row.economic_flow==="expense")
  .map(row=>{let date=dayInMonth(row.booked_on,Number(row.booked_on.slice(8,10)),1);if(date<=today)date=dayInMonth(row.booked_on,Number(row.booked_on.slice(8,10)),2);return {date,category:row.category,amount:-row.amount_minor};})
  .filter(bill=>bill.date>today && bill.date<payday).sort((a,b)=>a.date.localeCompare(b.date) || b.amount-a.amount);
 const billsTotal=exactSum(bills.map(bill=>bill.amount));
 const monthlySurprises=data.essentials_minor>0 ? data.essentials_minor : observedReserves(today,data)?.irregular ?? 0;
 const buffer=Math.round(monthlySurprises*days/30.4375);
 const usual=[1,2,3].map(offset=>{const period=monthPeriod(today,-offset);return {amount:Math.max(0,spendByBasket(period,data).find(group=>group.key==="everyday")?.amount??0),days:between(period.start,period.end)};});
 const usualPerDay=Math.round(exactSum(usual.map(item=>item.amount))/usual.reduce((sum,item)=>sum+item.days,0));
 const available=exactSum([review.balance,-billsTotal,-buffer,-purchase]);
 const perDay=available>0 ? Math.floor(available/days) : 0;
 // Past balances are rebuilt backwards from the booked rows; the forecast spends at the usual everyday pace.
 const booked=records({start:addDays(today,-29),end:addDays(today,1)},data);
 const history=Array.from({length:30},(_,index)=>{const date=addDays(today,index-29);return {date,balance:exactSum([review.balance!,...booked.filter(row=>row.booked_on>date).map(row=>-row.amount_minor)])};});
 const forecast=[{date:today,balance:review.balance}];
 for(let index=1;index<=days;index++){
  const date=addDays(today,index),due=exactSum(bills.filter(bill=>bill.date<=date).map(bill=>bill.amount));
  forecast.push({date,balance:exactSum([review.balance,-purchase,-due,-usualPerDay*index,...(date===payday ? [schedule.amount] : [])])});
 }
 const runsOutOn=forecast.find(item=>item.balance<0)?.date ?? null;
 return {status:"ready",today,payday,scheduledPayday,delayDays,days,balance:review.balance,income:schedule.amount,bills,billsTotal,buffer,purchase,available,perDay,usualPerDay,history,forecast,runsOutOn,coverage:"partial"};
}
