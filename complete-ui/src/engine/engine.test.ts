import {describe,it,expect} from "vitest";
import source from "../../data/demo.v1.json";
import {bankSummaries,benchmark,calendarMonthPeriodSchema,demo,exactSum,lastMonth,loadTransactions,monthlyAverages,records,safeToSpend,simulateReduction,spendByBasket,spendByCategory,spenderProfile,summary,monthPeriod,transactionHistory,basisPointAmount,sourceInventory} from "./index";

describe("real authored source and deterministic money",()=>{
  it("keeps absent expense periods unknown without losing recorded zero and refund-only observations",()=>{
    const data=structuredClone(demo),month={start:"2026-09-01",end:"2026-10-01"};
    data.transactions=data.transactions.filter(row=>row.booked_on<month.start || row.booked_on>=month.end);
    expect(summary(month,data).expenses).toBeNull();
    expect(monthlyAverages(3,data)).toMatchObject({months:3,observedExpenseMonths:2,expenses:null});
    const row={...demo.transactions[0],booked_on:"2026-09-03",economic_flow:"expense" as const,amount_minor:-1000};
    data.transactions.push(row,{...row,economic_flow:"refund",amount_minor:1000});
    expect(summary(month,data).expenses).toBe(0);expect(monthlyAverages(3,data).observedExpenseMonths).toBe(3);
    data.transactions=data.transactions.filter(transaction=>transaction!==row);
    expect(summary(month,data).expenses).toBe(-1000);
    expect(summary({start:"2026-11-02",end:"2026-11-03"}).expenses).toBeNull();
  });
  it("reports only included source-visible inventory and keeps missing date coverage null",()=>{
    expect(sourceInventory()).toMatchObject({count:13,accounts:2,statuses:{booked:13,pending:0,reversed:0},asOf:"2026-11-04",timezone:"Europe/Helsinki"});
    const data=structuredClone(demo);
    data.transactions.push({...data.transactions[0],booked_on:"2026-11-05"},{...data.transactions[0],account_id:"excluded"});
    expect(sourceInventory(data)).toEqual(sourceInventory());
    data.transactions=[{...data.transactions[0],status:"pending",booked_on:"2026-11-02"},{...data.transactions[0],status:"reversed",booked_on:"2026-11-03"}];
    expect(sourceInventory(data)).toMatchObject({count:2,first:"2026-11-02",last:"2026-11-03",statuses:{booked:0,pending:1,reversed:1}});
    data.transactions=[];expect(sourceInventory(data)).toMatchObject({count:0,first:null,last:null});
  });
  it("shows actual reservation/reversal history without counting it as spending or hypothetical savings",()=>{
    const data=structuredClone(demo),original=records(lastMonth).map(row=>row.id);
    data.transactions.push(
      {...data.transactions[0],id:"00000000-0000-4000-8000-000000000001",status:"pending",category:"dining",amount_minor:-90000},
      {...data.transactions[0],id:"00000000-0000-4000-8000-000000000002",status:"reversed",category:"dining",amount_minor:-80000},
      {...data.transactions[0],id:"00000000-0000-4000-8000-000000000003",status:"pending",booked_on:lastMonth.end},
    );
    const all=transactionHistory(lastMonth,"all",data);
    expect(all.map(row=>row.id)).toEqual([...original,"00000000-0000-4000-8000-000000000001","00000000-0000-4000-8000-000000000002"]);
    expect(transactionHistory(lastMonth,"reserved",data).map(row=>row.status)).toEqual(["pending"]);
    expect(transactionHistory(lastMonth,"booked",data).map(row=>row.id)).toEqual(original);
    expect(records(lastMonth,data).map(row=>row.id)).toEqual(original);
    expect(summary(lastMonth,data).expenses).toBe(86450);
    expect(simulateReduction("dining",20,lastMonth,data).monthly).toBe(5000);
    expect(()=>transactionHistory({start:lastMonth.end,end:lastMonth.start},"all",data)).toThrow();
    expect(()=>transactionHistory(lastMonth,"unknown" as "all",data)).toThrow();
    expect(demo.transactions).toHaveLength(13);
  });
  it("validates the real schema and rejects duplicate identities, sign errors and unknown accounts",()=>{
    expect(loadTransactions().transactions).toHaveLength(13);
    const duplicate=structuredClone(source);duplicate.profiles[0].transactions.push(duplicate.profiles[0].transactions[0]);expect(()=>loadTransactions(duplicate)).toThrow();
    const accounts=structuredClone(source);accounts.profiles[0].accounts.push(accounts.profiles[0].accounts[0]);expect(()=>loadTransactions(accounts)).toThrow("Duplicate account identity");
    const invalid=structuredClone(source);invalid.profiles[0].transactions[0].amount_minor=10;expect(()=>loadTransactions(invalid)).toThrow();
    invalid.profiles[0].transactions[0].amount_minor=-10;invalid.profiles[0].transactions[0].account_id="00000000-0000-4000-8000-000000000000";expect(()=>loadTransactions(invalid)).toThrow();
  });
  it("derives the two demo banks from source metadata and withholds missing/future balances",()=>{
    expect(bankSummaries()).toEqual([{id:"s-bank-demo",name:"S-Bank demo",accountCount:1,balance:50000},{id:"north-demo",name:"North demo bank",accountCount:1,balance:30000}]);
    const missing=structuredClone(demo);missing.balances=missing.balances.slice(1);
    expect(bankSummaries(missing).map(b=>b.balance)).toEqual([null,30000]);
    const future=structuredClone(demo);future.balances[0].observed_at="2026-11-05T00:00:00Z";
    expect(bankSummaries(future)[0].balance).toBeNull();
    const credit=structuredClone(demo);credit.balances[0].included_credit_minor=1000;
    expect(bankSummaries(credit)[0].balance).toBe(49000);
    const merged=structuredClone(demo);merged.accounts[1].institution_id=merged.accounts[0].institution_id;
    expect(bankSummaries(merged)).toEqual([{id:"s-bank-demo",name:null,accountCount:2,balance:80000}]);
    merged.accounts[1].included=false;expect(bankSummaries(merged)[0]).toMatchObject({accountCount:1,balance:50000});
  });
  it("category and basket sums reconcile to independently selected net expenses, excluding transfers",()=>{
    const expected=records(lastMonth).filter(r=>r.economic_flow==="expense" || r.economic_flow==="refund").reduce((sum,r)=>sum-r.amount_minor,0);
    expect(expected).toBe(86450);
    expect(spendByCategory(lastMonth).reduce((s,g)=>s+g.amount,0)).toBe(expected);
    expect(spendByBasket(lastMonth).reduce((s,g)=>s+g.amount,0)).toBe(expected);
    expect(spendByCategory(lastMonth).find(g=>g.key==="groceries")).toMatchObject({gross:12100,refunds:300,amount:11800});
    expect(spendByCategory(lastMonth).find(g=>g.key==="taxi")?.amount).toBe(4000);
  });
  it("keeps missing income and actual savings unknown, preserving partial-month history",()=>{
    expect(summary(lastMonth)).toEqual({income:null,savings:null,expenses:86450});
    expect(monthlyAverages(3)).toMatchObject({expenses:45483,income:null,coverage:"partial",start:"2026-08-01",end:"2026-11-01"});
    expect(()=>monthlyAverages(0)).toThrow();expect(monthPeriod("2024-03-15",-1)).toEqual({start:"2024-02-01",end:"2024-03-01"});
  });
  it("never counts future income, rejects stale permission and does not invent a savings reserve",()=>{
    const data=structuredClone(demo);data.transactions.push({...data.transactions[0],id:"00000000-0000-4000-8000-000000000000",economic_flow:"income",amount_minor:900000,booked_on:"2026-11-05"});
    const before=safeToSpend("2026-11-04",data);expect(before.realizedIncome).toBe(0);expect(before.savings).toBeNull();expect(before.amount).toBeNull();expect(before.illustrativeHeadroom).toBe(20000);
    expect(safeToSpend("2026-11-06",data)).toMatchObject({stale:true,amount:null,realizedIncome:0});
    expect(safeToSpend("2026-11-03",data).balance).toBeNull();
    data.as_of="2026-11-06T12:00:00Z";
    expect(safeToSpend("2026-11-06",data)).toMatchObject({amount:null,realizedIncome:900000,savings:90000});
  });
  it("requires one eligible balance per included account and respects exact Finnish source time",()=>{
    const missing=structuredClone(demo);missing.balances.pop();
    expect(safeToSpend("2026-11-04",missing)).toMatchObject({balance:null,illustrativeHeadroom:null,amount:null});
    const later=structuredClone(demo);later.balances[0].observed_at="2026-11-04T01:00:00+02:00";
    expect(safeToSpend("2026-11-04",later).balance).toBeNull();
    const ambiguous=structuredClone(demo);ambiguous.balances.push({...ambiguous.balances[0]});
    expect(safeToSpend("2026-11-04",ambiguous).balance).toBeNull();
    const utc=structuredClone(demo);utc.as_of=new Date(utc.as_of).toISOString();utc.balances.forEach(row=>{row.observed_at=new Date(row.observed_at).toISOString();});
    expect(safeToSpend("2026-11-03",utc).balance).toBeNull();
    expect(safeToSpend("2026-11-04",utc).balance).toBe(80000);
    const excluded=structuredClone(demo);excluded.accounts[1].included=false;
    expect(safeToSpend("2026-11-04",excluded).balance).toBe(50000);
    const zero=structuredClone(demo);zero.balances.forEach(row=>{row.amount_minor=0;});
    expect(safeToSpend("2026-11-04",zero)).toMatchObject({balance:0,illustrativeHeadroom:0,amount:null});
  });
  it("fences all transaction reads by source date and included accounts",()=>{
    const data=structuredClone(demo),november=monthPeriod("2026-11-04");
    data.transactions.push({...data.transactions[0],id:"00000000-0000-4000-8000-000000000099",booked_on:"2026-11-05"});
    expect(records(november,data).map(row=>row.booked_on)).toEqual(["2026-11-01"]);
    expect(transactionHistory(november,"all",data).map(row=>row.booked_on)).toEqual(["2026-11-01"]);
    data.accounts[0].included=false;
    const visible=records(lastMonth,data);
    expect(visible.length).toBeGreaterThan(0);expect(visible.every(row=>row.account_id===data.accounts[1].id)).toBe(true);
    expect(transactionHistory(lastMonth,"all",data).every(row=>row.account_id===data.accounts[1].id)).toBe(true);
  });
  it("rejects unsafe cent inputs before cancellation and rounds basis points exactly",()=>{
    expect(()=>exactSum([Number.MAX_SAFE_INTEGER+1,-Number.MAX_SAFE_INTEGER])).toThrow("Unsafe minor-unit input");
    expect(()=>exactSum([0.5,0.5])).toThrow();expect(()=>exactSum([NaN])).toThrow();
    expect(basisPointAmount(1,5000)).toBe(1);expect(basisPointAmount(1,4999)).toBe(0);
    expect(basisPointAmount(25000,2025)).toBe(5063);expect(basisPointAmount(Number.MAX_SAFE_INTEGER,10000)).toBe(Number.MAX_SAFE_INTEGER);
    expect(()=>basisPointAmount(Number.MAX_SAFE_INTEGER+1,10)).toThrow();
    expect(()=>basisPointAmount(100,-1)).toThrow();expect(()=>basisPointAmount(100,10001)).toThrow();
  });
  it("calculates exact historical reductions, boundaries and annualized assumptions",()=>{
    expect(simulateReduction("dining",20)).toMatchObject({monthly:5000,annual:60000,incomeShare:null,baseline:25000});
    expect(simulateReduction("dining",0).monthly).toBe(0);expect(simulateReduction("dining",100).monthly).toBe(25000);
    expect(()=>simulateReduction("dining",101)).toThrow();expect(()=>simulateReduction("dining",20.001)).toThrow();
    expect(()=>simulateReduction("absent",20)).toThrow("baseline is required");
    expect(()=>exactSum([Number.MAX_SAFE_INTEGER,1])).toThrow();
    for(const period of [{start:"2026-10-09",end:"2026-10-10"},{start:"2026-10-26",end:"2026-11-02"},{start:"2026-09-01",end:"2026-11-01"},{start:"2026-11-01",end:"2026-11-05"}]) {
      expect(()=>simulateReduction("dining",20,period)).toThrow("one calendar month");
      expect(()=>benchmark("taxi",undefined,period)).toThrow("one calendar month");
    }
    expect(calendarMonthPeriodSchema.safeParse({start:"2024-02-01",end:"2024-03-01"}).success).toBe(true);
    expect(calendarMonthPeriodSchema.safeParse({start:"0099-02-01",end:"0099-03-01"}).success).toBe(true);
    expect(calendarMonthPeriodSchema.safeParse({start:"2026-02-30",end:"2026-03-01"}).success).toBe(false);
  });
  it("intersects literal source filters, preserves refunds and withholds nonpositive scenario baselines",()=>{
    expect(records(lastMonth,demo,{category:"taxi",merchant:"HELSINKI"}).map(r=>r.amount_minor)).toEqual([-1890]);
    expect(records(lastMonth,demo,{merchant:"%"})).toEqual([]);
    expect(records(lastMonth,demo,{merchant:"_"})).toEqual([]);
    expect(records(lastMonth,demo,{category:"groceries"}).map(r=>r.amount_minor)).toEqual([-12100,300]);
    const data=structuredClone(demo),refund=data.transactions.find(r=>r.economic_flow==="refund")!;
    refund.amount_minor=20000;
    expect(()=>simulateReduction("groceries",20,lastMonth,data)).toThrow("baseline is required");
    data.transactions=[refund];
    expect(()=>simulateReduction("groceries",20,lastMonth,data)).toThrow("baseline is required");
    expect(()=>records({start:"2025-01-01",end:"2026-11-01"})).toThrow();
    expect(monthPeriod("0099-02-15")).toEqual({start:"0099-02-01",end:"0099-03-01"});
  });
  it("describes facts without a personality score and keeps approximate reference comparison unverified",()=>{
    expect(spenderProfile()).toMatchObject({type:"observed_pattern",leading:{key:"housing",amount:35000},total:86450});
    expect(benchmark("taxi")).toMatchObject({you:4000,typical:450,comparable:false,approximate:true,reference:{year:2022}});
    expect(benchmark("dining").typical).toBeNull();
  });
});
