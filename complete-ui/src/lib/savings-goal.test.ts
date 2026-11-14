import {it,expect} from "vitest";
import {goalAmountInput,goalAmountMinor} from "./savings-goal";

it("accepts exact decimal goals and rejects rounding, non-decimal input and unsafe cents",()=>{
  for(const [text,minor] of [["0,01",1],["0.29",29],[" 1234,56 ",123456],["100",10000],["90071992547409.91",Number.MAX_SAFE_INTEGER]] as const) {
    expect(goalAmountMinor(text)).toBe(minor);
    expect(goalAmountMinor(goalAmountInput(minor))).toBe(minor);
  }
  for(const value of ["","0","0,00","-1","+1","1.001","1e3","1,000.00","Infinity","90071992547409.92","9".repeat(1000)]) expect(goalAmountMinor(value)).toBeNull();
  expect(()=>goalAmountInput(-1)).toThrow();expect(()=>goalAmountInput(Number.MAX_SAFE_INTEGER+1)).toThrow();
});
