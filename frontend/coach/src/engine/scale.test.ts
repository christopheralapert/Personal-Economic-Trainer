import {it,expect} from "vitest";
import {demo,loadTransactions,analyzePeriod,spendByCategory,spendByBasket,summary,exactSum,transactionHistory} from "./index";
import {scopedDataset} from "./data-scope";
import {weeklyRange} from "./planning";
it("keeps exact totals, isolation and mutable callers correct with 100k generated rows",()=>{
 const transactions=Array.from({length:100000},(_,i)=>({...demo.transactions[0],id:`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,booked_on:`2026-10-${String(i%28+1).padStart(2,"0")}`,category:i%2 ? "Coffee" : "Dining",basket:"everyday" as const,economic_flow:"expense" as const,status:"booked" as const,amount_minor:-101}));
 const mutable={...demo,transactions},data=loadTransactions({notice:"Generated test-only 100k fixture",profiles:[mutable]}),period={start:"2026-10-01",end:"2026-11-01"};
 expect(transactionHistory(period,"booked",data)).toHaveLength(100000);expect(summary(period,data).expenses).toBe(10100000);
 expect(exactSum(spendByCategory(period,data).map(g=>g.amount))).toBe(10100000);expect(exactSum(spendByBasket(period,data).map(g=>g.amount))).toBe(10100000);
 const poisoned=analyzePeriod(period,data);poisoned.categories[0].amount=1;poisoned.baskets.length=0;poisoned.period.start="2025-01-01";
 expect(summary(period,data).expenses).toBe(10100000);expect(spendByBasket(period,data)).toHaveLength(1);expect(analyzePeriod(period,data).period).toEqual(period);
 const scope={excludedCategories:["Coffee"]};const reduced=scopedDataset(data,scope);expect(scopedDataset(data,scope)).toBe(reduced);expect(summary(period,reduced).expenses).toBe(5050000);
 expect(weeklyRange({data:reduced}).high).toBeNull();expect(weeklyRange({data}).high!).toBeLessThanOrEqual(weeklyRange({data}).cap!);
 const before=summary(period,mutable).expenses;mutable.transactions[0].amount_minor=-202;expect(summary(period,mutable).expenses).toBe(before!+101);expect(summary(period,data).expenses).toBe(10100000);
});
