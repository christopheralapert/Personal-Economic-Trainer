import {it,expect} from "vitest";
import {money,signedMoney} from "./format";

it("formats every safe integer cent exactly, including sub-euro outflow and the precision boundary",()=>{
  expect(money(123456).replace(/\s/g,"")).toBe("1234,56€");
  expect(money(-1).replace(/\s/g,"")).toBe("−0,01€");
  expect(money(Number.MAX_SAFE_INTEGER).replace(/\s/g,"")).toBe("90071992547409,91€");
  expect(money(-Number.MAX_SAFE_INTEGER).replace(/\s/g,"")).toBe("−90071992547409,91€");
  expect(signedMoney(1).replace(/\s/g,"")).toBe("+0,01€");expect(signedMoney(0).replace(/\s/g,"")).toBe("0,00€");
  for(const invalid of [NaN,Infinity,.5,Number.MAX_SAFE_INTEGER+1]) expect(()=>money(invalid)).toThrow();
});
