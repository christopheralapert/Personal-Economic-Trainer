import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {openBudget,liveDirectory} from "./live-budget.mjs";
import {coachRevision} from "./revision.mjs";

const args=process.argv.slice(2),port=args.length===0 ? 3001 : args.length===2 && args[0]==="--port" ? Number(args[1]) : NaN;
if(!Number.isInteger(port) || port<1024 || port>65535) {console.log("Use --port with a local port between 1024 and 65535.");process.exit(2);}
const app=fileURLToPath(new URL("../",import.meta.url)),origin=`http://127.0.0.1:${port}`,revision=coachRevision();
try {
  const gemini=process.env.MONEY_COACH_LOCAL_GEMINI==="true";
  if(!gemini && process.env.MONEYLENS_MODEL_BILLING_POLICY!=="free_only") throw new Error("policy");
  const built=JSON.parse(await readFile(path.join(app,".next/required-server-files.json"),"utf8"));
  if(built.config.env.NEXT_PUBLIC_MONEY_COACH_REVISION!==revision) throw new Error("build");
  if(gemini) {
    if(!process.env.GEMINI_API_KEY) throw new Error("key");
    console.log(`Local Gemini evaluation: ${origin}; provider: ${process.env.MONEY_COACH_GEMINI_MOCK==="true" ? "mock" : "Google"}.`);
  } else {
    const budget=await openBudget({directory:liveDirectory,key:process.env.MONEYLENS_OPENAI_API_KEY,requiredOrigin:origin,requiredRevision:revision});
    const summary=budget.summary();await budget.close();
    console.log(JSON.stringify({localEvaluation:origin,model:summary.model,attemptsAlreadyCounted:summary.attempts,possibleCostMicroEUR:summary.countedCostMicroEUR,maximumCostMicroEUR:summary.maximumCostMicroEUR,expiresAt:summary.expiresAt}));
  }
} catch {
  console.log("Local AI preview was not started: build, policy or current origin/revision-bound evaluation grant is unavailable. No API request was made; the normal demo remains available.");
  process.exit(2);
}
const next=fileURLToPath(new URL("../../../node_modules/next/dist/bin/next",import.meta.url));
const child=spawn(process.execPath,[next,"start",app,"--hostname","127.0.0.1","--port",String(port)],{
  cwd:app,windowsHide:true,stdio:"inherit",env:{...process.env,MONEY_COACH_LOCAL_AI_EVALUATION:"true",MONEY_COACH_LOCAL_AI_ORIGIN:origin,MONEY_COACH_EVALUATION_DIRECTORY:liveDirectory},
});
const stop=()=>child.kill();process.once("SIGINT",stop);process.once("SIGTERM",stop);
child.once("error",()=>{console.log("Local preview process could not start.");process.exitCode=1;});
child.once("exit",code=>{process.exitCode=code ?? 1;});
