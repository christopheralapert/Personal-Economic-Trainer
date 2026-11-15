import {describe,it,expect,vi} from "vitest";
import {access,mkdtemp,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {publicAIPolicy,withPublicAIReservation} from "./public-budget";

async function fixture(run:(env:Record<string,string>,file:string)=>Promise<void>){
 const directory=await mkdtemp(path.join(os.tmpdir(),"public-ai-budget-")),file=path.join(directory,"budget.json");
 try{await run({MONEY_COACH_PUBLIC_AI_BUDGET_PATH:file,MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"20"},file);}finally{await rm(directory,{recursive:true,force:true});}
}
const state=(file:string)=>readFile(file,"utf8").then(JSON.parse);
describe("shared hosted AI allowance",()=>{
 it("requires an explicit finite lifetime grant and canonical configuration",async()=>fixture(async(env)=>{
  expect(publicAIPolicy(env)).toMatchObject({maximumRequests:20,requestsPerMinute:6,maximumMicroEUR:null,reservationMicroEUR:0});
  for(const key of ["MONEY_COACH_PUBLIC_AI_MAX_REQUESTS","MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE"]){
   for(const value of ["","0","-1","1.1","1e1","0x10"," 2","2 ","02","NaN","Infinity","9007199254740992"]){
    expect(()=>publicAIPolicy({...env,[key]:value})).toThrow("public_ai_configuration");
   }
  }
  for(const invalid of [{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:undefined},{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"10001"},{MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE:"61"},{MONEY_COACH_PUBLIC_AI_BUDGET_PATH:"relative.json"},{MONEY_COACH_PUBLIC_AI_BUDGET_PATH:undefined},{MONEY_COACH_MODEL_USAGE_PATH:env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH},{MONEY_COACH_VOICE_LEDGER_PATH:env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH}])expect(()=>publicAIPolicy({...env,...invalid})).toThrow("public_ai_configuration");
 }));
 it("validates the optional money pair without coercion or an unlimited escape",async()=>fixture(async(env)=>{
  for(const invalid of [
   {MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"100"},{MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"10"},
   ...["","0","-1","1.5","Infinity","9007199254740992"].flatMap(value=>[{MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:value,MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"10"},{MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"100",MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:value}]),
   {MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"10",MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"11"},
  ])expect(()=>publicAIPolicy({...env,...invalid})).toThrow("public_ai_configuration");
 }));
 it("writes the full reservation before a callback and never refunds a failure",async()=>fixture(async(env,file)=>{
  const policy=publicAIPolicy({...env,MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"200",MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"100"});
  const run=vi.fn(async()=>{expect(await state(file)).toMatchObject({version:1,requests:1,reservedMicroEUR:100});throw Error("synthetic network failure");});
  await expect(withPublicAIReservation(policy,run)).rejects.toThrow("synthetic network failure");
  expect(await withPublicAIReservation(policy,async()=>"fresh")).toBe("fresh");
  await expect(withPublicAIReservation(publicAIPolicy({...env,MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"200",MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"100"}),run)).rejects.toMatchObject({code:"public_ai_budget_limit",status:429});
  expect(run).toHaveBeenCalledTimes(1);expect(await state(file)).toMatchObject({requests:2,reservedMicroEUR:200});
 }));
 it("enforces a durable lifetime request cap even after the rate window expires",async()=>fixture(async(env,file)=>{
  const configured={...env,MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"1"},run=vi.fn(async()=>"value");
  await withPublicAIReservation(publicAIPolicy(configured),run,undefined,()=>1000);
  await expect(withPublicAIReservation(publicAIPolicy(configured),run,undefined,()=>100000)).rejects.toMatchObject({code:"public_ai_request_limit"});
  expect(run).toHaveBeenCalledTimes(1);expect(await state(file)).toMatchObject({requests:1});
 }));
 it("uses a sliding rate window across processes/restarts and expires at exactly 60 seconds",async()=>fixture(async(env,file)=>{
  const configured={...env,MONEY_COACH_PUBLIC_AI_REQUESTS_PER_MINUTE:"1"},run=vi.fn(async()=>true);
  await withPublicAIReservation(publicAIPolicy(configured),run,undefined,()=>1000);
  await expect(withPublicAIReservation(publicAIPolicy(configured),run,undefined,()=>60999)).rejects.toMatchObject({code:"public_ai_rate_limit",status:429,retryAfter:"1"});
  await withPublicAIReservation(publicAIPolicy(configured),run,undefined,()=>61000);
  expect(run).toHaveBeenCalledTimes(2);expect(await state(file)).toMatchObject({requests:2,recent:[61000]});
 }));
 it("rejects another operation while a reservation callback is active and releases after failure",async()=>fixture(async(env)=>{
  const policy=publicAIPolicy(env);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),first=withPublicAIReservation(policy,async()=>{await gate;throw Error("synthetic failure");});
  const observed=expect(first).rejects.toThrow("synthetic failure");
  await vi.waitFor(()=>expect(access(policy.file)).resolves.toBeUndefined());
  const blocked=vi.fn(async()=>true);
  try{await expect(withPublicAIReservation(publicAIPolicy(env),blocked)).rejects.toMatchObject({code:"public_ai_busy",status:429,retryAfter:"5"});}finally{release();}
  await observed;expect(blocked).not.toHaveBeenCalled();expect(await withPublicAIReservation(policy,blocked)).toBe(true);
 }));
 it("fails closed on malformed state, unsafe counters, clock rollback and retained crash locks",async()=>fixture(async(env,file)=>{
  const policy=publicAIPolicy(env),run=vi.fn(async()=>true);
  for(const invalid of ["not-json","{}",JSON.stringify({version:1,requests:-1,reservedMicroEUR:0,recent:[]}),JSON.stringify({version:1,requests:9007199254740992,reservedMicroEUR:0,recent:[]}),JSON.stringify({version:1,requests:1,reservedMicroEUR:0,recent:[1001]}),JSON.stringify({version:1,requests:2,reservedMicroEUR:0,recent:[2,1]}),JSON.stringify({version:1,requests:1,reservedMicroEUR:0,recent:[]})]){
   await writeFile(file,invalid);await expect(withPublicAIReservation(policy,run,undefined,()=>1000)).rejects.toMatchObject({code:"public_ai_ledger",status:503});
  }
  await writeFile(file+".lock","");await expect(withPublicAIReservation(policy,run)).rejects.toMatchObject({code:"public_ai_busy"});expect(run).not.toHaveBeenCalled();
 }));
 it("retains its lock if a durable reservation cannot be saved and never runs the callback",async()=>fixture(async(env,file)=>{
  await writeFile(file+".next","synthetic interrupted save");const run=vi.fn(async()=>true),policy=publicAIPolicy(env);
  await expect(withPublicAIReservation(policy,run)).rejects.toMatchObject({code:"public_ai_ledger"});
  await expect(access(file+".lock")).resolves.toBeUndefined();
  await expect(withPublicAIReservation(policy,run)).rejects.toMatchObject({code:"public_ai_busy"});expect(run).not.toHaveBeenCalled();
 }));
 it("does not consume a reservation for an already cancelled operation",async()=>fixture(async(env,file)=>{
  const controller=new AbortController();controller.abort();const run=vi.fn(async()=>true);
  await expect(withPublicAIReservation(publicAIPolicy(env),run,controller.signal)).rejects.toThrow();
  await expect(access(file)).rejects.toThrow();expect(run).not.toHaveBeenCalled();
 }));
});
