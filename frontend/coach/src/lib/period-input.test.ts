import {it,expect} from "vitest";
import {inclusiveThrough,periodFromDates,periodPreset} from "./period-input";

it("bounds inclusive date inputs and presets to the explicit source snapshot",()=>{
  expect(periodFromDates("2024-02-29","2024-02-29","2024-03-01")).toEqual({ok:true,period:{start:"2024-02-29",end:"2024-03-01"}});
  expect(inclusiveThrough("2024-03-01")).toBe("2024-02-29");
  for(const [start,end] of [["","2026-10-31"],["2026-02-30","2026-03-01"],["2026-11-02","2026-11-01"],["2024-01-01","2026-01-01"]]) expect(periodFromDates(start,end,"2026-11-04")).toEqual({ok:false,reason:"invalid"});
  expect(periodFromDates("2026-11-01","2026-11-05")).toEqual({ok:false,reason:"future"});
  expect(periodFromDates("9999-12-31","9999-12-31","9999-12-31")).toEqual({ok:false,reason:"invalid"});
  expect(periodPreset("previous")).toEqual({start:"2026-10-01",end:"2026-11-01"});
  expect(periodPreset("snapshot")).toEqual({start:"2026-11-01",end:"2026-11-05"});
});
