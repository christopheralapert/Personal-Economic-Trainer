import {describe,it,expect} from "vitest";
import {spokenAnswer} from "./spoken-answer";
import {loadDataset} from "@/engine/datasets";
import {transactionPage} from "@/engine/history";
import {spendByCategory,exactSum} from "@/engine";
import {money} from "@/lib/format";
import type {Locale} from "@/i18n/dictionaries";

const period={start:"2026-08-01",end:"2026-09-01"};
describe("speech describes the checked financial answer",()=>{
 for(const locale of ["en","fi","et"] as Locale[]) {
  it(`speaks transaction amount, subject, and source month in ${locale}`,async()=>{
   const data=await loadDataset("organizer1"),filters={category:"taxi"};
   const output={period,filters,...transactionPage(period,"booked",data,filters)};
   const text=spokenAnswer("showTransactions",{period,...filters},output,locale);
   expect(text).toContain(money(output.netExpenses!));expect(text).toContain("2026");
   expect(text).toMatch(locale==="en" ? /taxis.*August|August.*taxis/i : locale==="fi" ? /takseihin.*elokuussa/ : /takso/i);
  });
 }
 it("also describes non-taxi Finnish amounts instead of only a record count",async()=>{
  const data=await loadDataset("organizer1"),filters={category:"dining"};
  const output={period,filters,...transactionPage(period,"booked",data,filters)};
  expect(output.netExpenses).not.toBeNull();
  const text=spokenAnswer("showTransactions",{period,...filters},output,"fi");
  expect(text).toContain(money(output.netExpenses!));expect(text).toContain("elokuussa 2026");
 });
 it("describes category totals rather than provider attribution",async()=>{
  const groups=spendByCategory(period,await loadDataset("organizer1"));
  const text=spokenAnswer("showCategories",{period},{period,groups},"en");
  expect(text).toContain(money(exactSum(groups.map(group=>group.amount))));
  expect(text).toContain("2026");expect(text).not.toMatch(/Answered with|local rules/);
 });
});
