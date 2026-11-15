import {describe,it,expect} from "vitest";
import {loadDataset} from "@/engine/datasets";
import {weeklyRange,recurringIncome} from "@/engine/planning";
import {safeToSpend,spenderProfile,observedReserves,monthPeriod,spendByBasket,type Dataset} from "@/engine";
import {sourceDate} from "@/engine/source-date";
import {resolveQuestion} from "@/coach/resolve-question";
import {adaptIntentToData} from "@/coach/intent";
import {RuleProvider} from "@/coach/rule-provider";
import {propsSchemas} from "@/coach/catalog";

describe("safe to spend on organizer profiles without reviewed reserves",()=>{
 it("reserves typical bills and surprise costs from the profile's own complete months",async()=>{
  const data=await loadDataset("organizer1"),today=sourceDate(data.as_of);
  expect([data.bills_minor,data.essentials_minor,data.buffer_minor]).toEqual([0,0,0]);
  const regular=[1,2,3].map(i=>spendByBasket(monthPeriod(today,-i),data).find(g=>g.key==="mandatory_regular")!.amount).sort((a,b)=>a-b)[1];
  const reserves=observedReserves(today,data)!;
  expect(reserves).toMatchObject({regular,months:6});
  const review=safeToSpend(today,data);
  expect(review).toMatchObject({status:"review_required",amount:null,reserveSource:"observed",reserveMonths:6,regular,irregular:reserves.irregular});
  expect(review.illustrativeHeadroom).toBe(review.balance!-regular-reserves.irregular-review.savings!);
  // The catalog's consistency checks accept the observed reserves unchanged.
  expect(()=>propsSchemas.showSafeToSpend.parse({purpose:"spend",result:review})).not.toThrow();
 });
 it("keeps supplied reserves for datasets that have them",async()=>{
  const data=await loadDataset("starter");
  expect(safeToSpend(sourceDate(data.as_of),data)).toMatchObject({reserveSource:"supplied",reserveMonths:null,regular:data.bills_minor});
 });
 it("produces a cautious weekly range below the bill-free figure",async()=>{
  const data=await loadDataset("organizer1"),range=weeklyRange({data});
  const billFree:Dataset={...data,bills_minor:1,essentials_minor:0,buffer_minor:0};
  expect(range.high).not.toBeNull();expect(range.low!).toBeLessThan(range.high!);
  expect(range.high!).toBeLessThan(weeklyRange({data:billFree}).high!);
 });
 it("detects salary whose payment day moves between months",async()=>{
  const data=await loadDataset("organizer1");
  const salary=data.transactions.filter(row=>row.category==="salary" && row.booked_on>="2026-06-01" && row.booked_on<"2026-09-01").map(row=>row.amount_minor).sort((a,b)=>a-b);
  expect(recurringIncome(data)).toBe(salary[1]);
 });
});

describe("what kind of spender am I",()=>{
 it("describes a spending style from the three baskets",async()=>{
  const data=await loadDataset("organizer1"),profile=spenderProfile(monthPeriod(sourceDate(data.as_of),-1),data);
  const gross=profile.baskets.reduce((sum,g)=>sum+g.gross,0),everyday=profile.baskets.find(g=>g.key==="everyday")!.gross/gross*100;
  expect(profile.style).toBe("everyday_led");expect(profile.styleShare).toBeCloseTo(everyday,6);
  const answer=await new RuleProvider().answer("What kind of spender am I?","en",10,{data});
  expect((answer.parts[0] as {text:string}).text).toContain("Spending style: Everyday spender.");
 });
 it("has no style without spending",()=>{
  const empty={as_of:"2026-09-30T20:59:59Z",accounts:[],balances:[],transactions:[],bills_minor:0,essentials_minor:0,buffer_minor:0,mode:"synthetic",name:"Empty"} as unknown as Dataset;
  expect(spenderProfile(monthPeriod("2026-09-30",-1),empty)).toMatchObject({style:null,styleShare:null});
 });
});

describe("organizer categories and comparisons",()=>{
 it("understands every organizer spending category in English, Finnish and Estonian",()=>{
  const ask=(question:string)=>resolveQuestion(question,undefined,undefined,"2026-09-30");
  for(const [phrase,category] of [["entertainment","entertainment"],["travel","travel"],["utilities","utilities"],["health","health"],["transport","transport"],["lifestyle","lifestyle"],["home and technology","home_tech"]])
   expect(ask(`How much did I spend on ${phrase} last month?`),phrase).toMatchObject({status:"ready",tool:"showTransactions",scope:{category}});
  expect(ask("Paljonko kulutin viihteeseen viime kuussa?")).toMatchObject({status:"ready",scope:{category:"entertainment"}});
  expect(ask("Kui palju kulutasin meelelahutusele eelmisel kuul?")).toMatchObject({status:"ready",scope:{category:"entertainment"}});
  expect(ask("How much could I save if I reduced entertainment by 30%?")).toMatchObject({status:"ready",tool:"showWhatIf",category:"entertainment",pct:30});
 });
 it("compares organizer customers with similar synthetic customers, and others with Statistics Finland",async()=>{
  const organizer=await loadDataset("organizer1"),starter=await loadDataset("starter");
  const generic=resolveQuestion("Compare me to others",undefined,undefined,"2026-09-30");
  expect(adaptIntentToData(generic,organizer)).toMatchObject({tool:"peerComparison",metric:"everyday"});
  expect(adaptIntentToData(generic,starter)).toMatchObject({tool:"showBenchmark",category:"taxi"});
  const explicit=resolveQuestion("Compare my taxi spending to others",undefined,undefined,"2026-09-30");
  expect(adaptIntentToData(explicit,organizer)).toEqual(explicit);
  const answer=await new RuleProvider().answer("Compare me to others","en",10,{data:organizer});
  expect(answer.parts.find(part=>part.type==="tool-peerComparison")).toMatchObject({output:{result:{status:"ready",metric:"everyday"}}});
 });
});
