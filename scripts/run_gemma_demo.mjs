// Start the web demo with local Gemma answering in Privacy mode.
// Verifies a loopback Ollama serving local GGUF Gemma weights, warms the model so the
// first question is not a cold load, then starts Next.js. Never downloads weights.
//   npm run dev:gemma                       development server on port 3000
//   npm run dev:gemma -- --port 3100        another port
//   npm run dev:gemma -- --prod --dist .next/presentation-ready   an existing production build
import {spawn} from "node:child_process";
import {existsSync} from "node:fs";
import path from "node:path";

const args=process.argv.slice(2),option=(name,fallback)=>{const index=args.indexOf(name);return index>=0 && args[index+1] ? args[index+1] : fallback;};
const port=option("--port","3000"),prod=args.includes("--prod"),dist=option("--dist",null);
if(existsSync(".env"))process.loadEnvFile(".env");
const model=process.env.MONEY_COACH_LOCAL_GEMMA_MODEL||"gemma3:4b",base=process.env.MONEY_COACH_LOCAL_GEMMA_URL||"http://127.0.0.1:11434";
const url=new URL(base);
if(url.protocol!=="http:" || !["127.0.0.1","localhost","[::1]"].includes(url.hostname)){console.error("Gemma must be a loopback http:// Ollama address.");process.exit(1);}
if(!/^\d{2,5}$/.test(port)){console.error("Invalid --port.");process.exit(1);}

async function post(endpoint,body,timeout){
 const response=await fetch(url.origin+endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.timeout(timeout)});
 if(!response.ok)throw new Error(`${endpoint} returned HTTP ${response.status}`);
 return response.json();
}
try {
 const info=await post("/api/show",{model},10000);
 const local=info.details?.format==="gguf" && String(info.details?.family??"").startsWith("gemma") && !info.remote_host && !info.remote_model;
 if(!local)throw new Error(`${model} is not a local GGUF Gemma model.`);
 console.log(`Gemma: ${model} (${info.details.parameter_size??"?"}, ${info.details.quantization_level??"?"}) at ${url.origin}`);
 const started=Date.now();
 await post("/api/chat",{model,stream:false,keep_alive:"30m",messages:[{role:"user",content:"Reply with OK."}],options:{num_predict:4}},180000);
 console.log(`Gemma warmed up in ${((Date.now()-started)/1000).toFixed(1)} s; kept loaded for 30 minutes.`);
} catch(error) {
 console.error(`Local Gemma is not ready: ${error instanceof Error ? error.message : error}`);
 console.error(`Install Ollama, run "ollama pull ${model}", and keep Ollama on ${url.origin}. Privacy mode still works with local rules without it.`);
 process.exit(1);
}

const env={...process.env,MONEY_COACH_LOCAL_GEMMA_ENABLED:"true",MONEY_COACH_LOCAL_GEMMA_MODEL:model,MONEY_COACH_LOCAL_GEMMA_URL:url.origin,...(dist ? {MONEYLENS_NEXT_DIST:dist} : {})};
const next=path.resolve("node_modules/next/dist/bin/next");
const child=spawn(process.execPath,[next,prod ? "start" : "dev","frontend/web","--hostname","127.0.0.1","--port",port],{env,stdio:"inherit",windowsHide:true});
console.log(`Money Coach: http://127.0.0.1:${port}/demo (Privacy mode on = local Gemma; Privacy off = Gemini only if configured)`);
child.on("exit",code=>{process.exitCode=code??0;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
