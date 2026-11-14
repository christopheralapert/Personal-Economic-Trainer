import test from "node:test";
import assert from "node:assert/strict";
import {syntheticCsv,measure} from "../../scripts/measure_statement_imports.mjs";

test("700-row performance fixture retains the recorded baseline bytes and cents",()=>{
  const csv=syntheticCsv();assert.equal(Buffer.byteLength(csv),28639);
  const lines=csv.trimEnd().split("\n");assert.equal(lines.length,701);
  assert.equal(new Set(lines.slice(1).map(line=>line.split(",")[0])).size,700);
  assert(lines.slice(1).every(line=>line.endsWith(",03-10-2026,-5.00,EUR,Synthetic shop")));
});

test("timing entry point rejects external origins and unapproved setup without launching Chrome",async()=>{
  await assert.rejects(measure("https://example.com"),/loopback/);
  const previous=process.env.MONEYLENS_PERFORMANCE_REHEARSAL;
  try{delete process.env.MONEYLENS_PERFORMANCE_REHEARSAL;
    await assert.rejects(measure("http://127.0.0.1:33120"),/opt-in/);
  }finally{if(previous===undefined)delete process.env.MONEYLENS_PERFORMANCE_REHEARSAL;else process.env.MONEYLENS_PERFORMANCE_REHEARSAL=previous;}
  for(const count of [0,-1,1001,1.5])assert.throws(()=>syntheticCsv(count));
});
