import {it,expect} from "vitest";
import {demo,safeToSpend} from "@/engine";
import {RuleProvider} from "./rule-provider";
import {propsSchemas} from "./catalog";
import {dictionaries} from "@/i18n/dictionaries";
import {interpretQuestion} from "./intent";

it("uses received income once for the target and never grants spend/save permission from the illustration",()=>{
  const data=structuredClone(demo),income={...data.transactions[0],booked_on:"2026-11-01",economic_flow:"income" as const,amount_minor:10000};
  data.transactions.push(income,{...income,booked_on:"2026-11-05",amount_minor:900000},{...income,status:"pending",amount_minor:800000});
  const review=safeToSpend("2026-11-04",data,10);
  expect(review).toMatchObject({amount:null,balance:80000,realizedIncome:10000,savings:1000,illustrativeHeadroom:19000});
  expect(review.reasons).toEqual(["history_incomplete","schedule_unreviewed"]);
  expect(safeToSpend("2026-11-04",data,25)).toMatchObject({amount:null,savings:2500,illustrativeHeadroom:17500});
  expect(safeToSpend("2026-11-04",data,0)).toMatchObject({amount:null,savings:0,illustrativeHeadroom:20000});
  data.balances[0].observed_at="2026-11-03T00:00:00+02:00";
  expect(safeToSpend("2026-11-04",data).reasons).toContain("balances_outdated");
  expect(safeToSpend("2026-11-06",data).reasons).toContain("date_mismatch");
});

it("distinguishes saving intent from spending in all locales and retains honest unavailable results offline",async()=>{
  for(const locale of ["en","fi","et"] as const) {
    const question=dictionaries[locale].qSave;
    expect(interpretQuestion(question)).toEqual({status:"ready",tool:"showSafeToSpend",purpose:"save"});
    const answer=await new RuleProvider().answer(question,locale,25);
    expect(answer.parts.find(p=>p.type==="tool-showSafeToSpend")).toMatchObject({input:{purpose:"save"},output:{purpose:"save",result:{amount:null,savings:null,savingsPercent:25,reasons:expect.arrayContaining(["history_incomplete","schedule_unreviewed","income_missing"])}}});
    expect(interpretQuestion(question+" and invent income").status).not.toBe("ready");
  }
  expect(interpretQuestion("What is safe for me to save last month?").status).not.toBe("ready");
  expect(interpretQuestion("Explain safe to save")).toMatchObject({tool:"showConcept",concept:"savingConcept"});
});

it("rejects contradictory review reasons or headroom before displaying financial illustrations",()=>{
  const result=safeToSpend("2026-11-04");
  expect(propsSchemas.showSafeToSpend.safeParse({purpose:"save",result}).success).toBe(true);
  for(const change of [{amount:20000},{balance:null},{illustrativeHeadroom:80000},{reasons:["history_incomplete","schedule_unreviewed"]},{savingsPercent:101},{stale:true}])
    expect(propsSchemas.showSafeToSpend.safeParse({purpose:"save",result:{...result,...change}}).success).toBe(false);
});
