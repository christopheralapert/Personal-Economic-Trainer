import {it,expect} from "vitest";
import {proactiveInsights} from "./insights";
import {demo,lastMonth} from "./index";
it("shows supported observations, caps cards and suppresses sparse comparisons",()=>{
 const result=proactiveInsights(lastMonth);expect(result).toHaveLength(1);expect(result[0]).toMatchObject({kind:"share",category:"dining",amount:25000});
 expect(result[0].share).toBeCloseTo(25000/30650*100);expect(proactiveInsights(lastMonth,{...demo,transactions:[]})).toEqual([]);
});
