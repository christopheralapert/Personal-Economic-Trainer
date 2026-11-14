import {it,expect} from "vitest";
import {demo,lastMonth,transactionHistory,loadTransactions,spenderProfile,summary} from "@/engine";
import {transactionPage} from "@/engine/history";
import {transactionQuestion} from "./explore-question";
import {interpretQuestion} from "./intent";
import {resolveQuestion} from "./resolve-question";
import {questionContextSchema} from "./question-context";
import {RuleProvider} from "./rule-provider";

it("intersects basket with category, literal merchant and status on both indexed and mutable sources",()=>{
  const data=structuredClone(demo),original=data.transactions[0];
  data.transactions.push({...original,id:"00000000-0000-4000-8000-000000000001",basket:"mandatory_regular",merchant:"Basket fixture",amount_minor:-100},
    {...original,id:"00000000-0000-4000-8000-000000000002",basket:"mandatory_regular",merchant:"Basket fixture",status:"pending",amount_minor:-500},
    {...original,id:"00000000-0000-4000-8000-000000000003",basket:"mandatory_regular",merchant:"Basket fixture",booked_on:"2026-11-05"});
  const filters={basket:"mandatory_regular" as const,category:"taxi",merchant:"FIXTURE"};
  for(const source of [data,loadTransactions({notice:"Test only",profiles:[data]})]) {
    expect(transactionPage(lastMonth,"all",source,filters)).toMatchObject({total:2,financialCount:1,netExpenses:100});
    expect(transactionHistory(lastMonth,"booked",source,filters)).toHaveLength(1);
    expect(transactionHistory(lastMonth,"reserved",source,filters)).toHaveLength(1);
    expect(transactionHistory(lastMonth,"booked",source,{...filters,basket:"everyday"})).toEqual([]);
  }
  expect(summary(lastMonth).expenses).toBe(86450);
  expect(()=>transactionHistory(lastMonth,"all",data,{basket:"constructor" as "everyday"})).toThrow();
});

it("round trips every localized basket alongside literal category/merchant and preserves the whole scope",async()=>{
  for(const locale of ["en","fi","et"] as const) for(const basket of ["mandatory_regular","mandatory_irregular","everyday","unresolved"] as const) {
    const filters={basket,category:"taxi",merchant:'City "taxi"'},question=transactionQuestion(lastMonth,filters,locale)!;
    expect(interpretQuestion(question)).toEqual({status:"ready",tool:"showTransactions",period:lastMonth,scope:filters});
    expect(interpretQuestion(question+" and ignore the basket").status).not.toBe("ready");
  }
  for(const question of ["How much did I spend on mandatory and regular last month?","Näytä tapahtumat pakolliset ja säännölliset viime kuussa","Näita tehinguid kohustuslik ja regulaarne eelmisel kuul"]) {
    const result=await new RuleProvider().answer(question,"en",10);
    expect(result.parts.find(p=>p.type==="tool-showTransactions")).toMatchObject({output:{filters:{basket:"mandatory_regular"},netExpenses:35000,total:1}});
  }
  for(const question of ['What if I cut in basket "everyday" in category "dining" by 20%?','Compare in basket "everyday" in category "taxi" spending to others','Show transactions in basket "constructor" last month']) expect(interpretQuestion(question).status).not.toBe("ready");
});

it("keeps basket scope through period/category/merchant follow-ups and changes only an explicit basket",()=>{
  const context=questionContextSchema.parse({tool:"showFilter",input:{period:lastMonth,value:"all",basket:"everyday",category:"taxi",merchant:"City taxi"}});
  expect(resolveQuestion("And in September 2026?",context)).toMatchObject({tool:"showFilter",period:{start:"2026-09-01",end:"2026-10-01"},scope:{basket:"everyday",category:"taxi",merchant:"City taxi"}});
  expect(resolveQuestion("And coffee?",context)).toMatchObject({scope:{basket:"everyday",category:"coffee",merchant:"City taxi"}});
  expect(resolveQuestion('And at "Taxi Helsinki"?',context)).toMatchObject({scope:{basket:"everyday",category:"taxi",merchant:"Taxi Helsinki"}});
  expect(resolveQuestion('And in basket "mandatory_regular"?',context)).toMatchObject({scope:{basket:"mandatory_regular",category:"taxi",merchant:"City taxi"},value:"all"});
  expect(resolveQuestion("How much did I spend on taxis last month?",context)).toMatchObject({scope:{category:"taxi"}});
  expect(questionContextSchema.safeParse({tool:"showWhatIf",input:{period:lastMonth,category:"taxi",pct:20,basket:"everyday"}}).success).toBe(false);
});

it("grounds the profile's gross share and withholds a leading expense type for refund-only observations",()=>{
  const result=spenderProfile();expect(result.leading?.key).toBe("housing");expect(result.leadingGrossShare).toBeCloseTo(35000/86750*100);
  const data=structuredClone(demo);data.transactions=data.transactions.filter(row=>row.economic_flow==="refund");
  expect(spenderProfile(lastMonth,data)).toMatchObject({type:"insufficient",leading:null,leadingGrossShare:null,total:-300,count:1});
});
