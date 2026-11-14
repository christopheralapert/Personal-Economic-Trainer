import {it,expect} from "vitest";
import {demo,lastMonth,spendByBasket,spendByCategory} from "./index";
import {classificationQueue,emptyScope,scopedDataset} from "./data-scope";
import {createComponentTools,propsSchemas} from "@/coach/catalog";
it("classification corrections change baskets without changing money or mutating source",async()=>{
 const queue=classificationQueue(demo);expect(queue).toHaveLength(3);const selected=queue[0],scope={...emptyScope,corrections:{[selected.id]:{basket:"mandatory_regular" as const}}},changed=scopedDataset(demo,scope);
 expect(changed).not.toBe(demo);expect(spendByCategory(lastMonth,changed)).toEqual(spendByCategory(lastMonth,demo));
 expect(spendByBasket(lastMonth,changed).find(g=>g.key==="mandatory_regular")!.amount).toBe(35000-selected.amount_minor);
 expect(demo.transactions.find(row=>row.id===selected.id)!.basket).toBe("everyday");expect(classificationQueue(changed,scope.corrections).some(row=>row.id===selected.id)).toBe(false);
 const tool=createComponentTools(10,changed).showBaskets;expect((await tool.execute!({period:lastMonth},{toolCallId:"test",messages:[],context:{}}))).toMatchObject({groups:spendByBasket(lastMonth,changed)});
});
it("rejects unknown correction identity or category instead of accepting replacement amounts",()=>{
 expect(()=>scopedDataset(demo,{...emptyScope,corrections:{[demo.transactions[0].id]:{amount_minor:1}}})).toThrow();
 expect(()=>scopedDataset(demo,{...emptyScope,corrections:{[demo.transactions[0].id]:{category:"invented"}}})).toThrow();
});

it("account and category selectors exclude records from all financial tool reads",async()=>{
 const scope={...emptyScope,excludedCategories:["taxi"]},filtered=scopedDataset(demo,scope),tools=createComponentTools(10,filtered);
 expect(filtered.transactions.some(row=>row.category==="taxi")).toBe(false);expect(spendByCategory(lastMonth,filtered).some(group=>group.key==="taxi")).toBe(false);
 const options={toolCallId:"scope-test",messages:[],context:{}};
 const transactions=await tools.showTransactions.execute!({period:lastMonth,category:"taxi"},options);expect(transactions).toMatchObject({rows:[],total:0,netExpenses:null});
 const summary=await tools.showSummary.execute!({period:lastMonth},options);expect(summary).toMatchObject({expenses:82450});
 const accounts=scopedDataset(demo,{...emptyScope,excludedAccounts:[demo.accounts[0].id]});expect(accounts.transactions.every(row=>row.account_id!==demo.accounts[0].id)).toBe(true);
 const safe=propsSchemas.showSafeToSpend.parse(await createComponentTools(10,accounts).showSafeToSpend.execute!({purpose:"spend"},options));expect(safe.result.balance).toBeNull();expect(safe.result.amount).toBeNull();
});
