import {it,expect} from "vitest";
import source from "../../data/extended.v1.json";
import {datasetFor,extendedDemo} from "./datasets";
import {demo,records,summary,spendByCategory,spendByBasket,exactSum,lastMonth} from "./index";
import {recurringIncome,weeklyRange} from "./planning";
import {monthOutlook,billsAhead} from "./outlook";
import {scopedDataset} from "./data-scope";
it("keeps reference data intact and reconciles generated money to explicit opening funds",()=>{
 expect(datasetFor("starter")).toBe(demo);expect(demo.transactions).toHaveLength(13);expect(extendedDemo.transactions).toHaveLength(368);
 for(const balance of extendedDemo.balances){const opening=source.generator.opening_minor[balance.account_id as keyof typeof source.generator.opening_minor];expect(balance.amount_minor).toBe(exactSum([opening,...extendedDemo.transactions.filter(r=>r.account_id===balance.account_id).map(r=>r.amount_minor)]));}
 expect(new Set(extendedDemo.transactions.map(r=>r.id)).size).toBe(368);expect(extendedDemo.transactions.every(r=>r.currency==="EUR" && r.booked_on<="2026-11-04")).toBe(true);
 const total=summary(lastMonth,extendedDemo).expenses;expect(exactSum(spendByCategory(lastMonth,extendedDemo).map(g=>g.amount))).toBe(total);expect(exactSum(spendByBasket(lastMonth,extendedDemo).map(g=>g.amount))).toBe(total);
 expect(exactSum(extendedDemo.transactions.filter(r=>r.economic_flow==="internal_transfer").map(r=>r.amount_minor))).toBe(0);
});
it("supports honest recurring bills, historical pace and weekly comparisons without spending future salary",()=>{
 expect(recurringIncome(extendedDemo)).toBe(280000);expect(billsAhead(extendedDemo)).toHaveLength(4);expect(monthOutlook(lastMonth,extendedDemo)?.points).toHaveLength(31);expect(monthOutlook(lastMonth,extendedDemo)?.points.at(-1)?.actual).toBe(summary(lastMonth,extendedDemo).expenses);
 const future={...extendedDemo.transactions[0],id:"future",economic_flow:"income" as const,amount_minor:999999,booked_on:"2026-11-25"};expect(weeklyRange({data:{...extendedDemo,transactions:[...extendedDemo.transactions,future]}})).toEqual(weeklyRange({data:extendedDemo}));
 const removed=scopedDataset(extendedDemo,{excludedCategories:["taxi"]});expect(records(lastMonth,removed).some(r=>r.category==="taxi")).toBe(false);expect(weeklyRange({data:removed}).high).toBeNull();
});
