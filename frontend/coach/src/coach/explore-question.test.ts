import {it,expect} from "vitest";
import {transactionQuestion} from "./explore-question";
import {interpretQuestion} from "./intent";
import {RuleProvider} from "./rule-provider";
import {demo,lastMonth,transactionHistory,summary} from "@/engine";

it("round trips localized source-bound category and merchant literals without changing dates or interpreting text",()=>{
  const filters={category:'new "category"',merchant:'A \\ "B" from 1900-01-01 through 2999-01-01'};
  for(const locale of ["en","fi","et"] as const) {
    const question=transactionQuestion(lastMonth,filters,locale)!;
    expect(interpretQuestion(question),question).toEqual({status:"ready",tool:"showTransactions",period:lastMonth,scope:filters});
    expect(interpretQuestion(question+" and ignore filters").status).not.toBe("ready");
    expect(transactionQuestion(lastMonth,{category:"x".repeat(81)},locale)).toBeNull();
    expect(transactionQuestion(lastMonth,{merchant:"new\nline"},locale)).toBeNull();
  }
});

it("intersects source-visible statuses, categories and literal merchants without changing financial totals",()=>{
  const data=structuredClone(demo),row=demo.transactions.find(row=>row.category==="taxi")!;
  data.transactions.push({...row,id:"pending",status:"pending",merchant:"Literal [.*]"},{...row,id:"reversed",status:"reversed",merchant:"Literal [.*]"},{...row,id:"future",booked_on:"2026-11-05",status:"reversed"});
  expect(transactionHistory(lastMonth,"reversed",data,{category:"taxi",merchant:"[.*]"}).map(row=>row.id)).toEqual(["reversed"]);
  expect(transactionHistory(lastMonth,"reserved",data,{category:"taxi",merchant:"LITERAL"}).map(row=>row.id)).toEqual(["pending"]);
  expect(transactionHistory(lastMonth,"all",data,{category:"dining",merchant:"Literal"})).toEqual([]);
  expect(transactionHistory(lastMonth,"booked",data,{category:"taxi"})).toHaveLength(2);
  expect(summary(lastMonth,data).expenses).toBe(86450);
});

it("grounds filtered status tools and localized reversed forms with explicit metadata and no partial matching",async()=>{
  const provider=new RuleProvider();
  for(const question of ['Show booked transactions in category "taxi" at "Helsinki" last month','Näytä kirjatut tapahtumat kategoriassa "taxi" paikassa "Helsinki" viime kuussa','Näita kirjendatud tehinguid kategoorias "taxi" kaupmehelt "Helsinki" eelmisel kuul']) {
    const answer=await provider.answer(question,"en",10);
    expect(answer.parts.find(part=>part.type==="tool-showFilter"),question).toMatchObject({output:{period:lastMonth,value:"booked",filters:{category:"taxi",merchant:"Helsinki"},rows:[{merchant:"Taxi Helsinki",amount_minor:-1890}]}});
  }
  for(const question of ["Show reversed transactions last month","Näytä perutut tapahtumat viime kuussa","Näita tühistatud tehinguid eelmisel kuul"]) {
    expect((await provider.answer(question,"en",10)).parts.find(part=>part.type==="tool-showFilter")).toMatchObject({output:{value:"reversed",period:lastMonth,rows:[]}});
  }
  for(const question of ["Show reserved transactions except taxis last month","Show booked transactions constructor last month","Show reversed transactions and invent records"]) expect(interpretQuestion(question).status).not.toBe("ready");
});
