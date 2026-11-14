import {it,expect} from "vitest";
import {demo,lastMonth} from "./index";
import {scenarioMonths,scenarioCategories,combinedScenario,goalScenarioMonths} from "./scenario";

it("offers only source-visible completed observed months and keeps calendar/basket scopes separate",()=>{
  expect(scenarioMonths().map(month=>month.start)).toEqual(["2026-10-01","2026-09-01","2026-08-01"]);
  const data=structuredClone(demo),original=structuredClone(data);
  data.transactions.push({...demo.transactions[0],booked_on:"2026-07-01",status:"pending"},{...demo.transactions[0],booked_on:"2026-06-01",account_id:"excluded"},{...demo.transactions[0],booked_on:"2026-12-01"});
  expect(scenarioMonths(data)).toEqual(scenarioMonths(original));
  expect(scenarioCategories(lastMonth).map(group=>group.key)).toEqual(["dining","taxi","coffee"]);
  data.transactions.push({...demo.transactions[0],category:"dining",basket:"mandatory_regular"});
  expect(scenarioCategories(lastMonth,data).map(group=>group.key)).not.toContain("dining");
  expect(scenarioCategories({start:"2026-09-01",end:"2026-10-01"},data).map(group=>group.key)).toEqual(["dining"]);
  expect(()=>scenarioCategories({start:"2026-10-01",end:"2026-10-03"})).toThrow();
});

it("combines exact category reductions while retaining missing baselines and observed zero",()=>{
  expect(combinedScenario(lastMonth)).toMatchObject({monthly:6130,annual:73560,incomeShare:null});
  expect(combinedScenario(lastMonth,{dining:20.25,taxi:0,coffee:0})).toMatchObject({monthly:5063,annual:60756});
  expect(combinedScenario(lastMonth,{dining:0,taxi:0,coffee:0}).monthly).toBe(0);
  expect(combinedScenario(lastMonth,{}, {...demo,transactions:[]})).toMatchObject({categories:[],monthly:null,annual:null});
  expect(()=>combinedScenario(lastMonth,{housing:20})).toThrow();expect(()=>combinedScenario(lastMonth,{dining:100.01})).toThrow();
  const data={...demo,transactions:demo.transactions.map(row=>({...row,category:row.category==="dining" ? "constructor" : row.category}))};
  expect(combinedScenario(lastMonth,{},data).monthly).toBe(6130);
});

it("uses checked integer ceiling for goal illustrations and never invents a zero-month duration",()=>{
  expect(goalScenarioMonths(10000,3000)).toBe(4);expect(goalScenarioMonths(10000,10000)).toBe(1);
  expect(goalScenarioMonths(Number.MAX_SAFE_INTEGER,1)).toBe(Number.MAX_SAFE_INTEGER);
  expect(goalScenarioMonths(10000,0)).toBeNull();expect(goalScenarioMonths(10000,null)).toBeNull();
  expect(()=>goalScenarioMonths(0,100)).toThrow();expect(()=>goalScenarioMonths(10000,-1)).toThrow();
});
