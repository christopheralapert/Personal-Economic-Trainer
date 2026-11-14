import {it,expect} from "vitest";
import {demo,monthPeriod} from "./index";
import {monthOutlook,recurringItems,billsAhead} from "./outlook";
it("hides unsupported outlooks and bills on the partial source",()=>{
 expect(monthOutlook(monthPeriod("2026-11-04"))).toBeNull();expect(recurringItems()).toEqual([]);expect(billsAhead()).toEqual([]);
});
it("detects a monthly cadence without treating projected salary as money",()=>{
 const row=demo.transactions[0],transactions=[8,9,10].flatMap(month=>[
 {...row,id:`salary-${month}`,merchant:"Employer",economic_flow:"income" as const,amount_minor:200000,booked_on:`2026-${String(month).padStart(2,"0")}-20`},
 {...row,id:`bill-${month}`,merchant:"Rent",basket:"mandatory_regular" as const,economic_flow:"expense" as const,amount_minor:-35000,booked_on:`2026-${String(month).padStart(2,"0")}-10`}]);
 const data={...demo,transactions};expect(billsAhead(data)).toEqual([{merchant:"Rent",flow:"expense",amount:35000,due:"2026-11-10"}]);
 const future={...transactions[0],booked_on:"2026-12-20",amount_minor:900000};expect(recurringItems({...data,transactions:[...transactions,future]})).toEqual(recurringItems(data));
 expect(billsAhead({...data,transactions:transactions.filter(row=>row.economic_flow!=="income")})).toEqual([]);
});
it("uses integer cumulative amounts and hides future observations",()=>{
 const row=demo.transactions[0],transactions=[8,9,10,11].flatMap(month=>Array.from({length:15},(_,i)=>({...row,id:`${month}-${i}`,booked_on:`2026-${String(month).padStart(2,"0")}-${String(i+1).padStart(2,"0")}`,amount_minor:-100,economic_flow:"expense" as const})));
 const data={...demo,as_of:"2026-11-12T12:00:00+02:00",transactions},result=monthOutlook(monthPeriod("2026-11-12"),data)!;
 expect(monthOutlook({start:"2026-11-01",end:"2026-11-05"},data)).toBeNull();expect(result.points[11].actual).toBe(1200);expect(result.points[12].actual).toBeNull();expect(result.points.every(p=>Number.isSafeInteger(p.typical))).toBe(true);
 expect(monthOutlook(monthPeriod("2026-10-12"),data)).toBeNull();expect(monthOutlook(monthPeriod("2026-11-12"),{...data,transactions:transactions.filter(r=>r.booked_on<="2026-11-12")})).toEqual(result);
});
