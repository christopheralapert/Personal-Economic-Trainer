import {z} from "zod";
import {describe,it,expect} from "vitest";
import source from "../../data/organizer-source.json";
import {loadDataset} from "./datasets";
import {records,spendByCategory,spendByBasket,monthPeriod,exactSum,safeToSpend} from "./index";
import {defaultPeriod} from "./planning";
import {createComponentTools} from "@/coach/catalog";
import {RuleProvider} from "@/coach/rule-provider";
import {resolveQuestion} from "@/coach/resolve-question";
import {createViewStore} from "@/lib/view-store";
import {displayedContext} from "@/coach/displayed-context";
import {sourceDate} from "./source-date";

describe("verified organizer subsets",()=>{
 it("retains all selected source records with stable distinct identities and honest reserves",async()=>{
  expect(source.source_rows).toBe(3626755);
  for(const key of ["organizer1","organizer2","organizer3"] as const){
   const data=await loadDataset(key),metadata=source.profiles.find(p=>p.key===key)!;
   expect(data.transactions).toHaveLength(metadata.rows);
   expect(new Set(data.transactions.map(row=>row.id)).size).toBe(metadata.rows);
   expect(sourceDate(data.as_of)).toBe("2026-09-30");
   expect(defaultPeriod(data)).toEqual({start:"2026-09-01",end:"2026-10-01"});
   expect((createComponentTools(10,data).showDonut.inputSchema as z.ZodType<Record<string,unknown>>).parse({}).period).toEqual({start:"2026-08-01",end:"2026-09-01"});
   const p=monthPeriod("2026-08-01"),categories=spendByCategory(p,data),baskets=spendByBasket(p,data);
   expect(exactSum(categories.map(g=>g.amount))).toBe(exactSum(baskets.map(g=>g.amount)));
   expect(data.transactions.some(row=>row.basket==="unresolved")).toBe(true);
   const review=safeToSpend(sourceDate(data.as_of),data);
   expect(review.amount).toBeNull();expect(review.reasons).toContain("history_incomplete");
  }
 });
 it("answers free text and compares taxi total/count to the same scoped deterministic records",async()=>{
  const data=await loadDataset("organizer1"),provider=new RuleProvider(),execution={data,period:defaultPeriod(data)};
  const questions=["How much did I spend on taxis last month?","What kind of spender am I?","What is safe for me to spend this week?","How much could I save if I reduced dining out by 20%?","Show transactions in August 2026"];
  for(const question of questions){const answer=await provider.answer(question,"en",10,execution);expect(answer.parts.some(p=>p.type.startsWith("tool-")),question).toBe(true);}
  const answer=await provider.answer(questions[0],"en",10,execution);
  const part=answer.parts.find(p=>p.type==="tool-showTransactions");
  if(!part || part.type!=="tool-showTransactions" || part.state!=="output-available")throw new Error("Missing tool result");
  const expected=records(monthPeriod("2026-08-01"),data,{category:"taxi"});
  expect(part.output.total).toBe(expected.length);
  expect(part.output.netExpenses).toBe(-exactSum(expected.map(r=>r.amount_minor)));
  const context=displayedContext([answer],createViewStore());
  expect(resolveQuestion("What about the month before?",context,execution.period,sourceDate(data.as_of))).toMatchObject({tool:"showTransactions",scope:{category:"taxi"},period:{start:"2026-07-01",end:"2026-08-01"}});
  const next=await provider.answer("What about the month before?","en",10,{...execution,context});
  expect(next.parts.find(p=>p.type==="tool-showTransactions")).toMatchObject({input:{category:"taxi",period:{start:"2026-07-01",end:"2026-08-01"}}});
 });
 it("rejects future requests using the selected profile date",()=>{
  expect(resolveQuestion("Show transactions in October 2026",undefined,undefined,"2026-09-30").status).toBe("clarification_required");
 });
});
