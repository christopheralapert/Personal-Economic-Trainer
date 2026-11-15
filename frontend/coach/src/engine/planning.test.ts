import {describe,it,expect} from "vitest";
import {demo,monthPeriod,snapshot} from "./index";
import {defaultPeriod,recurringIncome,weeklyRange} from "./planning";
describe("planning estimates remain separate from recorded money",()=>{
 it("requires repeated monthly inflows and excludes future income",()=>{
  const row=demo.transactions[0],data={...demo,transactions:["2026-08-01","2026-09-01","2026-10-01"].map((booked_on,i)=>({...row,id:`salary-${i}`,booked_on,amount_minor:200000,economic_flow:"income" as const,merchant:"Employer"}))};
  expect(recurringIncome(data)).toBe(200000);expect(recurringIncome({...data,transactions:data.transactions.slice(0,2)})).toBeNull();
  const future={...row,booked_on:"2026-12-01",amount_minor:900000,economic_flow:"income" as const,merchant:"Employer"};
  expect(weeklyRange({data:{...demo,transactions:[...demo.transactions,future]}})).toEqual(weeklyRange());
 });
 it("keeps low confidence below its existing-funds cap and estimates cannot add funds",()=>{
  const baseline=weeklyRange(),entered=weeklyRange({income:200000});
  expect(baseline.high).not.toBeNull();expect(baseline.high!).toBeLessThanOrEqual(baseline.cap!);expect(entered.high!).toBeLessThanOrEqual(baseline.high!);
  expect(baseline.review.amount).toBeNull();expect(weeklyRange({today:"2026-11-05"}).high).toBeNull();
 });
 it("defaults to the last complete month for sparse or early current data",()=>{
  expect(defaultPeriod()).toEqual(monthPeriod(snapshot,-1));
  const row=demo.transactions[0],data={...demo,as_of:"2026-11-15T12:00:00+02:00",transactions:Array.from({length:5},(_,i)=>({...row,id:String(i),booked_on:`2026-11-${String(i+1).padStart(2,"0")}`}))};
  expect(defaultPeriod(data)).toEqual({start:"2026-11-01",end:"2026-11-16"});expect(defaultPeriod({...data,transactions:data.transactions.slice(0,4)})).toEqual(monthPeriod("2026-11-15",-1));
 });
 it("cannot upgrade incomplete demo history to a verified allowance by checking boxes",()=>{
  const reviewed=weeklyRange({income:200000,billsConfirmed:true,classificationsReviewed:true});
  expect(reviewed.confidence).toBe("low");expect(reviewed.review.amount).toBeNull();
  expect(reviewed.high!).toBeLessThanOrEqual(reviewed.cap!);
 });
 it("withholds a range for stale balances even when the snapshot itself is unchanged",()=>{
  const stale={...demo,balances:demo.balances.map(row=>({...row,observed_at:"2026-11-03T12:00:00+02:00"}))};
  expect(weeklyRange({data:stale})).toMatchObject({low:null,high:null});
 });
 it("reports missing historical months rather than converting them to zero spending",()=>{
  expect(weeklyRange({data:{...demo,transactions:[]}})).toMatchObject({observedMonths:0,typical:null,high:null});
 });
 it("does not infer recurring income by merging unrelated account payments or old salaries",()=>{
  const row=demo.transactions[0],salary=(account_id:string,booked_on:string)=>({...row,id:account_id+booked_on,account_id,booked_on,amount_minor:200000,economic_flow:"income" as const,merchant:"Employer"});
  const split={...demo,transactions:[salary(demo.accounts[0].id,"2026-08-01"),salary(demo.accounts[1].id,"2026-09-01"),salary(demo.accounts[0].id,"2026-10-01")]};
  expect(recurringIncome(split)).toBeNull();
  const old={...demo,transactions:["2026-07-01","2026-08-01","2026-09-01"].map(day=>salary(demo.accounts[0].id,day))};
  expect(recurringIncome(old)).toBeNull();
 });
});

import {resolveQuestion} from "@/coach/resolve-question";
it("uses the shared period while explicit named months override it",()=>{
 const september=monthPeriod(snapshot,-2);
 const selected=resolveQuestion("Where did my money go this month?",undefined,september);
 expect(selected.status==="ready" && "period" in selected && selected.period).toEqual(september);
 const explicit=resolveQuestion("How much did I spend on taxis last month?",undefined,september);
 expect(explicit.status==="ready" && "period" in explicit && explicit.period).toEqual(monthPeriod(snapshot,-1));
});
