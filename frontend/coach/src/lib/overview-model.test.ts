import {it,expect} from "vitest";
import {overviewIncome,wholeMoney} from "./overview-model";
import {demo,lastMonth} from "@/engine";
import {extendedDemo} from "@/engine/datasets";
it("only asks for income when neither recorded, inferred nor user evidence exists",()=>{
 expect(overviewIncome(lastMonth,extendedDemo,null)).toEqual({amount:280000,source:"recorded",needsInput:false});
 expect(overviewIncome({start:"2026-04-01",end:"2026-05-01"},extendedDemo,null)).toEqual({amount:280000,source:"inferred",needsInput:false});
 expect(overviewIncome(lastMonth,demo,null)).toEqual({amount:null,source:null,needsInput:true});
 expect(overviewIncome(lastMonth,demo,220000)).toEqual({amount:220000,source:"user",needsInput:false});
 expect(wholeMoney(10853)).toContain("108");
});
