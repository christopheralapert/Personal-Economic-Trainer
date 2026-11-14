import {describe,it,expect} from "vitest";
import {loadTransactions,isLoadedSnapshot} from "./data";
import {demo,lastMonth,transactionHistory,analyzePeriod,summary,spendByCategory,spendByBasket,spenderProfile,simulateReduction,reductionFromAnalysis} from "./index";
import {combinedScenario} from "./scenario";

describe("immutable snapshot indexes and shared period observations",()=>{
  it("owns the loaded graph, rejects mutation and never caches caller-owned mutable fixtures",()=>{
    const input={notice:"Test only",profiles:[structuredClone(demo)]};
    const loaded=loadTransactions(input),before=transactionHistory(lastMonth,"all",loaded);
    expect(isLoadedSnapshot(loaded)).toBe(true);expect(isLoadedSnapshot(input.profiles[0])).toBe(false);
    expect(()=>loaded.transactions.push(loaded.transactions[0])).toThrow();
    expect(()=>{loaded.transactions[0].amount_minor=-1;}).toThrow();
    expect(()=>{loaded.accounts[0].included=false;}).toThrow();
    input.profiles[0].transactions=[];expect(transactionHistory(lastMonth,"all",loaded)).toEqual(before);
    const mutable=structuredClone(loaded);expect(transactionHistory(lastMonth,"all",mutable)).toEqual(before);
    mutable.transactions=[];expect(transactionHistory(lastMonth,"all",mutable)).toEqual([]);
    before.length=0;expect(transactionHistory(lastMonth,"all",loaded)).not.toEqual([]);
  });
  it("matches fresh linear reads across out-of-order dates, statuses, filters and source boundaries",()=>{
    const data=structuredClone(demo),template=data.transactions[0];
    data.transactions=[...data.transactions.reverse(),...Array.from({length:500},(_,i)=>({...template,
      id:`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,
      booked_on:i%7===0 ? "2026-11-05" : `2026-10-${String(i%28+1).padStart(2,"0")}`,
      merchant:i%2 ? "CITY TAXI" : "Literal %_ merchant",status:(["booked","pending","reversed"] as const)[i%3],
      category:i%2 ? "taxi" : "constructor"}))];
    const indexed=loadTransactions({notice:"Test only",profiles:[data]});
    for(const period of [lastMonth,{start:"2026-10-09",end:"2026-10-10"},{start:"2026-11-04",end:"2026-11-06"},{start:"2024-02-01",end:"2024-03-01"}])
      for(const status of ["all","booked","reserved","reversed"] as const)
        for(const filters of [{},{category:"taxi"},{merchant:"city"},{merchant:"%_"},{category:"constructor",merchant:"Literal"}])
          expect(transactionHistory(period,status,indexed,filters)).toEqual(transactionHistory(period,status,data,filters));
    // Account visibility is still evaluated on each read of a mutable dataset.
    transactionHistory(lastMonth,"all",data);data.accounts[0].included=false;
    expect(transactionHistory(lastMonth,"all",data).every(r=>r.account_id!==template.account_id)).toBe(true);
  });
  it("reconciles shared observations and simulations without leaking mutations into later reads",()=>{
    const mutable=structuredClone(demo),indexed=loadTransactions({notice:"Test only",profiles:[mutable]});
    const analysis=analyzePeriod(lastMonth,indexed);
    expect(analysis.categories).toEqual(spendByCategory(lastMonth,mutable));
    expect(analysis.baskets).toEqual(spendByBasket(lastMonth,mutable));
    expect(analysis.expenses).toBe(86450);expect(analysis.income).toBeNull();
    expect(()=>reductionFromAnalysis("dining",20,{start:"2026-09-01",end:"2026-10-01"},analysis)).toThrow("Analysis period mismatch");
    expect(summary(lastMonth,indexed)).toEqual(summary(lastMonth,mutable));
    expect(spenderProfile(lastMonth,indexed)).toEqual(spenderProfile(lastMonth,mutable));
    expect(simulateReduction("dining",20.25,lastMonth,indexed)).toEqual(simulateReduction("dining",20.25,lastMonth,mutable));
    expect(combinedScenario(lastMonth,{dining:20.25,taxi:0,coffee:100},indexed)).toEqual(combinedScenario(lastMonth,{dining:20.25,taxi:0,coffee:100},mutable));
    analysis.categories[0].amount=1;analysis.baskets.length=0;
    expect(analyzePeriod(lastMonth,indexed).expenses).toBe(86450);
    const empty=analyzePeriod({start:"2025-01-01",end:"2025-02-01"},indexed);
    expect(empty).toMatchObject({income:null,expenses:null,categories:[],baskets:[]});
  });
});
