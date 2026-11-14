import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {openBudget,keyFingerprint,MODEL,DAILY_TOKENS,MAX_ATTEMPTS,REQUEST_RESERVATION,MAX_COST_MICRO_EUR,REQUEST_COST_MICRO_EUR,costMicroEUR} from "../../scripts/live-budget.mjs";

async function fixture(run) {
  const directory=await mkdtemp(path.join(os.tmpdir(),"money-coach-budget-"));
  const state={version:1,model:MODEL,dailyTokens:DAILY_TOKENS,maxAttempts:MAX_ATTEMPTS,keyFingerprint:keyFingerprint("fake-key"),
    maximumCostMicroEUR:MAX_COST_MICRO_EUR,paidEvaluationAuthorized:true,
    sharingConfirmed:true,exclusiveUsageConfirmed:true,initialUsageTokens:0,confirmedAt:"2026-11-06T10:00:00Z",expiresAt:"2026-11-06T22:00:00Z",attempts:[]};
  await writeFile(path.join(directory,"allowance.json"),JSON.stringify(state));
  const options={directory,key:"fake-key",now:()=>new Date("2026-11-06T11:00:00Z")};
  try {await run(options,state);} finally {
    // Only the exact task-owned temporary directory may be removed recursively.
    if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("money-coach-budget-")) throw new Error("Unsafe test cleanup target");
    await rm(directory,{recursive:true,force:true});
  }
}
test("reserves durably before traffic, excludes a second writer, retains unknown usage and never resets automatically",async()=>fixture(async options=>{
  const budget=await openBudget(options),id=await budget.reserve();
  assert.equal(JSON.parse(await readFile(path.join(options.directory,"allowance.json"),"utf8")).attempts[0].countedTokens,REQUEST_RESERVATION);
  await assert.rejects(openBudget(options),{code:"budget_locked"});
  await budget.settle(id,null,"failed");assert.equal(budget.summary().countedTokens,REQUEST_RESERVATION);
  assert.equal(budget.summary().countedCostMicroEUR,REQUEST_COST_MICRO_EUR);
  await assert.rejects(budget.reserve(),{code:"budget_halted"});await budget.close();
  await assert.rejects(openBudget({...options,now:()=>new Date("2026-11-07T11:00:00Z")}),{code:"grant_expired"});
}));
test("settles exact receipts but enforces the shared attempt cap",async()=>fixture(async(options,state)=>{
  state.attempts=Array.from({length:MAX_ATTEMPTS},(_,i)=>({id:String(i),status:"completed",countedTokens:100,inputTokens:100,outputTokens:0,countedCostMicroEUR:costMicroEUR(100,0)}));
  await writeFile(path.join(options.directory,"allowance.json"),JSON.stringify(state));
  const full=await openBudget(options);await assert.rejects(full.reserve(),{code:"allowance_exhausted"});await full.close();
  state.attempts=[];await writeFile(path.join(options.directory,"allowance.json"),JSON.stringify(state));
  const budget=await openBudget(options),id=await budget.reserve();
  await budget.settle(id,{inputTokens:100,outputTokens:25,totalTokens:125},"model_tool");assert.equal(budget.summary().countedTokens,125);
  assert.equal(budget.summary().countedCostMicroEUR,costMicroEUR(100,25));
  await budget.close();await assert.rejects(openBudget({...options,key:"different-key"}),{code:"invalid_grant"});
}));

test("money headroom independently blocks requests even while token allowance remains",async()=>fixture(async(options,state)=>{
  state.attempts=[{id:"previous",status:"completed",countedTokens:250000,inputTokens:250000,outputTokens:0,countedCostMicroEUR:costMicroEUR(250000,0)}];
  await writeFile(path.join(options.directory,"allowance.json"),JSON.stringify(state));
  const budget=await openBudget(options);await assert.rejects(budget.reserve(),{code:"cost_exhausted"});await budget.close();
}));
