import {performance} from "node:perf_hooks";
import {fileURLToPath} from "node:url";
import {createJiti} from "jiti";

const size=Number(process.argv[2] ?? 100000);
if(!Number.isSafeInteger(size) || size<1000 || size>1000000) throw new Error("Choose 1,000 to 1,000,000 local benchmark rows");
const jiti=createJiti(import.meta.url);
const engine=await jiti.import(fileURLToPath(new URL("../src/engine/index.ts",import.meta.url)));
const {combinedScenario,scenarioCategories}=await jiti.import(fileURLToPath(new URL("../src/engine/scenario.ts",import.meta.url)));
const {demo,lastMonth,loadTransactions,transactionHistory,analyzePeriod}=engine;
const profile=structuredClone(demo),categories=["dining","taxi","coffee","housing","groceries","repairs"];
// Explicit benchmark-only records. Never written to the public demo or used as customer evidence.
profile.transactions=Array.from({length:size},(_,i)=>{
  const month=i%36,date=new Date(Date.UTC(2023,10+month,i%28+1)).toISOString().slice(0,10);
  const economic_flow=i%19===0 ? "income" : i%13===0 ? "internal_transfer" : i%11===0 ? "refund" : "expense";
  return {...demo.transactions[0],id:`00000000-0000-4000-8000-${String(i).padStart(12,"0")}`,
    account_id:demo.accounts[i%demo.accounts.length].id,booked_on:date,
    category:categories[Math.floor(i/36)%categories.length],merchant:`Benchmark merchant ${i%97}`,
    basket:"everyday",economic_flow,amount_minor:economic_flow==="income" ? 250000 : economic_flow==="refund" ? 200 : -(100+i%5000),
    status:i%17===0 ? "pending" : i%23===0 ? "reversed" : "booked"};
});
const heapBefore=process.memoryUsage().heapUsed,start=performance.now();
const indexed=loadTransactions({notice:"Local performance fixture only",profiles:[profile]});
const loadMs=performance.now()-start;
const coldStart=performance.now();transactionHistory(lastMonth,"all",indexed);const firstIndexedReadMs=performance.now()-coldStart;
const heapGrowthMiB=(process.memoryUsage().heapUsed-heapBefore)/1024/1024;
function measure(run,iterations=40) {
  for(let i=0;i<5;i++) run();
  const times=[];
  for(let i=0;i<iterations;i++) {const begin=performance.now();run();times.push(performance.now()-begin);}
  times.sort((a,b)=>a-b);return {medianMs:times[Math.floor(times.length/2)],p95Ms:times[Math.ceil(times.length*.95)-1],iterations};
}
const periods=[lastMonth,{start:"2026-10-09",end:"2026-10-10"},{start:"2024-02-01",end:"2024-03-01"}];
let cursor=0;
const indexedHistory=measure(()=>transactionHistory(periods[cursor++%periods.length],"booked",indexed,{merchant:"merchant 1"}));
cursor=0;const linearHistory=measure(()=>transactionHistory(periods[cursor++%periods.length],"booked",profile,{merchant:"merchant 1"}));
// Match full results first; timings are observations, never a flaky test threshold.
for(const period of periods) {
  if(JSON.stringify(transactionHistory(period,"booked",indexed,{merchant:"merchant 1"}))!==JSON.stringify(transactionHistory(period,"booked",profile,{merchant:"merchant 1"}))) throw new Error("Indexed history mismatch");
  if(JSON.stringify(analyzePeriod(period,indexed))!==JSON.stringify(analyzePeriod(period,profile))) throw new Error("Period analysis mismatch");
}
const periodAnalysis=measure(()=>analyzePeriod(lastMonth,indexed));
const combined=measure(()=>combinedScenario(lastMonth,{},indexed));
const repeatedScenario=measure(()=>{
  for(const group of scenarioCategories(lastMonth,indexed)) engine.simulateReduction(group.key,20,lastMonth,indexed);
  engine.summary(lastMonth,indexed);
});
console.log(JSON.stringify({fixture:"benchmark-only; not public source data",rows:size,node:process.version,loadMs,firstIndexedReadMs,heapGrowthMiB,indexedHistory,linearHistory,periodAnalysis,combinedScenario:combined,repeatedScenarioReads:repeatedScenario},null,2));
