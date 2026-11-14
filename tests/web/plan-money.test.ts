import assert from "node:assert/strict";
import {test} from "node:test";
import {euros,parseEuro, sumMinor} from "../../apps/web/components/plan-format.ts";

test("euro input preserves exact cents and supports decimal comma without rounding", () => {
  assert.equal(parseEuro("12.50"),1250);
  assert.equal(parseEuro(" 12,5 "),1250);
  assert.equal(parseEuro("0"),0);
  assert.equal(parseEuro("000.01"),1);
  assert.equal(parseEuro("90071992547409.91"),Number.MAX_SAFE_INTEGER);
  for (const value of ["", "-0", "-1", "1.005", "1,234", "1e3", "Infinity", "12 EUR", "0x20", "90071992547409.92"])
    assert.throws(() => parseEuro(value),undefined,value);
});

test("protection totals cannot silently overflow the canonical money range", () => {
  assert.equal(sumMinor([15000,10000,0]),25000);
  assert.throws(() => sumMinor([Number.MAX_SAFE_INTEGER,1]));
});

test("displayed euros preserve cents at both safe integer boundaries",()=>{
  const text=(value:number)=>euros(value).replace(/\s/g," ");
  assert.equal(text(Number.MAX_SAFE_INTEGER),"90 071 992 547 409,91 €");
  assert.equal(text(-Number.MAX_SAFE_INTEGER),"−90 071 992 547 409,91 €");
  assert.equal(text(-1),"−0,01 €");assert.equal(text(0),"0,00 €");
  for(const value of [1.2,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) assert.throws(()=>euros(value));
});
