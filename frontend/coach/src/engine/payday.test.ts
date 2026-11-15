import {describe,it,expect} from "vitest";
import {loadDataset} from "@/engine/datasets";
import {paydayForecast,incomeSchedule} from "@/engine/payday";
import {exactSum,records} from "@/engine";
import {resolveQuestion} from "@/coach/resolve-question";
import {RuleProvider} from "@/coach/rule-provider";
import {propsSchemas} from "@/coach/catalog";
import {conversationFacts} from "@/coach/conversation-provider";
import {money} from "@/lib/format";

describe("until payday",()=>{
 it("finds the salary day and amount from the last months",async()=>{
  const data=await loadDataset("organizer1");
  expect(incomeSchedule(data)).toMatchObject({dayOfMonth:15,lastPaid:"2026-09-15"});
  expect(incomeSchedule(await loadDataset("starter"))).toBeNull();
 });
 it("reserves bills due before payday and a prorated surprise buffer, then divides by the days left",async()=>{
  const data=await loadDataset("organizer1"),plan=paydayForecast({data});
  if(plan.status!=="ready")throw new Error("expected a plan");
  expect(plan).toMatchObject({today:"2026-09-30",payday:"2026-10-15",days:15,balance:466391});
  expect(plan.bills).toEqual([{date:"2026-10-02",category:"housing",amount:139020}]);
  expect(plan.available).toBe(plan.balance-plan.billsTotal-plan.buffer);
  expect(plan.perDay).toBe(Math.floor(plan.available/plan.days));
  expect(()=>propsSchemas.showPayday.parse({result:plan})).not.toThrow();
 });
 it("rebuilds past balances from booked rows and forecasts at the usual everyday pace",async()=>{
  const data=await loadDataset("organizer1"),plan=paydayForecast({data});
  if(plan.status!=="ready")throw new Error("expected a plan");
  expect(plan.history).toHaveLength(30);expect(plan.history.at(-1)).toEqual({date:"2026-09-30",balance:466391});
  const day=records({start:"2026-09-30",end:"2026-10-01"},data);
  expect(plan.history.at(-2)!.balance).toBe(466391-exactSum(day.map(row=>row.amount_minor)));
  expect(plan.forecast[2]).toEqual({date:"2026-10-02",balance:466391-139020-2*plan.usualPerDay});
  expect(plan.forecast.at(-1)!.balance).toBe(466391-139020-15*plan.usualPerDay+plan.income);
 });
 it("shows what a purchase and a late salary do",async()=>{
  const data=await loadDataset("organizer1"),base=paydayForecast({data}),bought=paydayForecast({data,purchase:20000}),late=paydayForecast({data,delayDays:7});
  if(base.status!=="ready" || bought.status!=="ready" || late.status!=="ready")throw new Error("expected plans");
  expect(bought.available).toBe(base.available-20000);expect(bought.perDay).toBeLessThan(base.perDay);
  expect(late).toMatchObject({payday:"2026-10-22",scheduledPayday:"2026-10-15",days:22});
  expect(late.perDay).toBeLessThan(base.perDay);expect(late.runsOutOn).not.toBeNull();
 });
 it("is unavailable without a salary or a current balance",async()=>{
  expect(paydayForecast({data:await loadDataset("starter")})).toMatchObject({status:"unavailable",reason:"income"});
  expect(paydayForecast({data:await loadDataset("organizer7")})).toMatchObject({status:"unavailable",reason:"balance"});
 });
 it("answers payday questions in English, Finnish and Estonian",async()=>{
  const ask=(question:string)=>resolveQuestion(question,undefined,undefined,"2026-09-30");
  expect(ask("How much can I spend per day until payday?")).toEqual({status:"ready",tool:"showPayday"});
  expect(ask("Paljonko voin käyttää päivässä palkkapäivään asti?")).toEqual({status:"ready",tool:"showPayday"});
  expect(ask("Kui palju võin päevas kulutada palgapäevani?")).toEqual({status:"ready",tool:"showPayday"});
  expect(ask("What if my salary is a week late?")).toEqual({status:"ready",tool:"showPayday",delay_days:7});
  expect(ask("What if my pay is 3 days late?")).toEqual({status:"ready",tool:"showPayday",delay_days:3});
  expect(ask("Entä jos palkka myöhästyy viikon?")).toEqual({status:"ready",tool:"showPayday",delay_days:7});
  expect(ask("Can I afford a 200 € purchase?")).toEqual({status:"ready",tool:"showPayday",purchase_minor:20000});
  expect(ask("Kas mul on raha 200-eurose ostu jaoks?")).toEqual({status:"ready",tool:"showPayday",purchase_minor:20000});
  expect(ask("can i afford €349.90")).toEqual({status:"ready",tool:"showPayday",purchase_minor:34990});
  const data=await loadDataset("organizer1"),answer=await new RuleProvider().answer("Can I afford a 200 € purchase?","en",10,{data});
  const part=answer.parts.find(item=>item.type==="tool-showPayday");
  expect(part).toMatchObject({input:{purchase_minor:20000},output:{result:{status:"ready",purchase:20000}}});
  const plan=paydayForecast({data,purchase:20000});if(plan.status!=="ready")throw new Error("expected a plan");
  expect((answer.parts[0] as unknown as {text:string}).text).toContain("a day until payday on 15 October.");
  // Model replies get the verified per-day amount and the payday facts, never ledger rows.
  const facts=conversationFacts("showPayday",{purchase_minor:20000},{result:plan},"en");
  expect(facts).toMatchObject({payday:{date:"2026-10-15",days:15,plannedPurchase:money(20000)}});
  expect(JSON.stringify(facts)).not.toContain(data.transactions[0].id);
 });
});
