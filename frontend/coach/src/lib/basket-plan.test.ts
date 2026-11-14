import {it,expect} from "vitest";
import {createBasketPlan,basketPlanRows} from "./basket-plan";
import {lastMonth,monthPeriod,snapshot} from "@/engine";
it("freezes starting basket budgets and changes only the chosen category baseline",()=>{
 const plan=createBasketPlan("dining",20000,15,lastMonth),before=JSON.stringify(plan);
 expect(plan.basketLimits).toMatchObject({mandatory_regular:35000,mandatory_irregular:20800,everyday:25650});
 expect(basketPlanRows(monthPeriod(snapshot),plan)[0].limit).toBeNull();expect(JSON.stringify(plan)).toBe(before);
 expect(()=>createBasketPlan("absent",20000,10,lastMonth)).toThrow();
});
