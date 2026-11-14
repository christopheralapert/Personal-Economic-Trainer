import {it,expect} from "vitest";
import {demo,lastMonth,loadTransactions} from "./index";
import {transactionPage,historyPageSchema} from "./history";
import {answerFromTool} from "@/coach/answer";
import {propsSchemas} from "@/coach/catalog";

it("pages every matching record once while totals include expenses and refunds beyond the first page",()=>{
  const data=structuredClone(demo);
  data.transactions=Array.from({length:80},(_,i)=>({...demo.transactions[0],id:`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,
    category:"taxi",merchant:`Page fixture ${i}`,booked_on:i<40 ? "2026-10-23" : "2026-10-09",amount_minor:i===79 ? 300 : -100,economic_flow:i===79 ? "refund" as const : "expense" as const}));
  const loaded=loadTransactions({notice:"Test only",profiles:[data]}),seen:string[]=[];
  for(let page=0;page<4;page++) {
    const result=transactionPage(lastMonth,"booked",loaded,{},page);
    expect(historyPageSchema.safeParse(result).success).toBe(true);expect(result).toMatchObject({total:80,financialCount:80,netExpenses:7600,page,pageSize:25});
    expect(result.rows).toHaveLength(page===3 ? 5 : 25);seen.push(...result.rows.map(row=>row.id));
  }
  expect(seen).toEqual(data.transactions.map(row=>row.id));expect(new Set(seen).size).toBe(80);
  const first=transactionPage(lastMonth,"booked",loaded);
  const answer=answerFromTool("showTransactions",{period:lastMonth,category:"taxi"},{...first,period:lastMonth,filters:{category:"taxi"}},"en");
  expect(answer.parts[0]).toMatchObject({type:"text",text:expect.stringMatching(/^76,00\s€ in recorded taxi expenses\.$/u)});
  expect(JSON.stringify(answer)).not.toContain("Page fixture 79");
  expect(transactionPage(lastMonth,"booked",loaded,{},999).page).toBe(3);
});

it("keeps reserved/reversed rows visible without counting them as booked spending and preserves observed zero",()=>{
  const data=structuredClone(demo),row=demo.transactions[0];
  data.transactions=[{...row,amount_minor:-100},{...row,id:"00000000-0000-4000-8000-000000000001",amount_minor:100,economic_flow:"refund"},
    {...row,id:"00000000-0000-4000-8000-000000000002",status:"pending",amount_minor:-99999},{...row,id:"00000000-0000-4000-8000-000000000003",status:"reversed",amount_minor:-88888}];
  expect(transactionPage(lastMonth,"all",data)).toMatchObject({total:4,financialCount:2,netExpenses:0});
  expect(transactionPage(lastMonth,"reserved",data)).toMatchObject({total:1,financialCount:0,netExpenses:null});
  expect(transactionPage(lastMonth,"reversed",data)).toMatchObject({total:1,financialCount:0,netExpenses:null});
  expect(transactionPage(lastMonth,"all",data,{merchant:"absent"})).toMatchObject({rows:[],total:0,page:0,netExpenses:null});
  expect(()=>transactionPage(lastMonth,"all",data,{},-1)).toThrow();expect(()=>transactionPage(lastMonth,"all",data,{},0,26)).toThrow();
});

it("rejects oversized or inconsistent native tool pages rather than treating a partial list as the full result",()=>{
  const valid={...transactionPage(lastMonth,"booked"),period:lastMonth,filters:{}};
  expect(propsSchemas.showTransactions.safeParse(valid).success).toBe(true);
  for(const extra of [{rows:Array(26).fill(demo.transactions[0])},{total:1},{page:100},{financialCount:0},{financialCount:1},{netExpenses:null},{netExpenses:1},{pageSize:0}])
    expect(propsSchemas.showTransactions.safeParse({...valid,...extra}).success).toBe(false);
});
