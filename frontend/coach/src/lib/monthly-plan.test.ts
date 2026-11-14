import {it,expect} from "vitest";
import {purchaseEquivalent,monthlyPlanSchema} from "./monthly-plan";
import {lastMonth,demo} from "@/engine";
it("uses actual coffee expense tickets, never invented coffee prices",()=>{
 expect(purchaseEquivalent(6130,lastMonth)).toEqual({category:"coffee",average:1650,count:3});expect(purchaseEquivalent(0,lastMonth)).toBeNull();expect(purchaseEquivalent(6130,lastMonth,{...demo,transactions:[]})).toBeNull();
 expect(monthlyPlanSchema.safeParse({id:crypto.randomUUID(),name:"Buffer",monthlyMinor:6130,targetMinor:73560,contributedMinor:null}).success).toBe(true);
 expect(monthlyPlanSchema.safeParse({id:crypto.randomUUID(),name:"",monthlyMinor:0,targetMinor:0,contributedMinor:null}).success).toBe(false);
});
