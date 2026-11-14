import {spawn} from "node:child_process";
import {readFile} from "node:fs/promises";
import {parseEnv} from "node:util";
import {fileURLToPath} from "node:url";
import path from "node:path";

const app=fileURLToPath(new URL("../",import.meta.url));
const root=path.resolve(app,"../..");
const args=process.argv.slice(2),mock=args.length===1 && ["--mock","--mock-missing","--mock-max"].includes(args[0]);
if(args.length && !mock) {console.error("Usage: node apps/money-coach/scripts/gemini-browser.mjs [--mock|--mock-missing|--mock-max]");process.exit(2);}
let key;
if(mock) key="local-fake-key";
else {
  try {key=parseEnv(await readFile(path.join(root,".env"),"utf8")).GEMINI_API_KEY;} catch { /* Report no secret or path contents. */ }
  if(!key?.trim()) {console.error("GEMINI_API_KEY is missing from the root .env file.");process.exit(2);}
}
const run=(command,args,env)=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[command,...args],{cwd:app,env,stdio:"inherit",windowsHide:true});
  child.once("error",reject);child.once("exit",code=>resolve(code ?? 1));
});
// Builds never need the key. Only the explicitly launched test server inherits it.
const clean={...process.env};delete clean.GEMINI_API_KEY;
const generate=path.join(app,"scripts/generate-pwa.mjs"),next=path.join(root,"node_modules/next/dist/bin/next"),playwright=path.join(root,"node_modules/@playwright/test/cli.js");
if(await run(generate,[],clean)!==0 || await run(next,["build",app],clean)!==0) {console.error("Local test build failed; no model request was made.");process.exit(1);}
const env={...clean,MONEY_COACH_LOCAL_GEMINI:"true",MONEY_COACH_GEMINI_MOCK:mock?"true":"false",MONEY_COACH_GEMINI_MOCK_MISSING:args[0]==="--mock-missing"?"true":"false",MONEY_COACH_GEMINI_MOCK_MAX:args[0]==="--mock-max"?"true":"false",MONEY_COACH_BROWSER_LIVE:"true",MONEY_COACH_ORGANIZER_SMOKE:"true",MONEY_COACH_BROWSER_SERVER_EXTERNAL:"true"};
// Refuse an existing listener; never send the key or test request to it.
try {await fetch("http://127.0.0.1:31322/",{signal:AbortSignal.timeout(1000)});console.error("Port 31322 is already in use; stop that server and retry.");process.exit(2);} catch(error) {if(error?.name!=="TypeError" && error?.name!=="TimeoutError") throw error;}
const server=spawn(process.execPath,[path.join(app,"scripts/preview-ai.mjs"),"--port","31322"],{cwd:app,env:{...env,GEMINI_API_KEY:key},stdio:"ignore",windowsHide:true});
let serverExited=false;server.once("exit",()=>{serverExited=true;});
let code=1;
try {
  let ready=false;
  for(let count=0;count<120 && !serverExited;count++) {
    try {const response=await fetch("http://127.0.0.1:31322/",{signal:AbortSignal.timeout(1000)});if(response.ok) {ready=true;break;}} catch {}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  if(!ready) throw new Error("Local test server did not start.");
  code=await run(playwright,["test","--config","playwright.ai.config.ts",...(mock?[]:["--headed"])],env);
} finally {
  if(process.platform==="win32" && server.pid) await new Promise(resolve=>{const killer=spawn("taskkill",["/PID",String(server.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});killer.once("error",resolve);killer.once("exit",resolve);});
  else server.kill("SIGTERM");
  server.unref();
}
if(code===0) console.log(mock ? "PASS: gemini-direct-mock; organizer1 taxi tool matched 30,97 € (August 2026)." : "PASS: gemini-direct; organizer1 taxi tool matched 30,97 € (August 2026).");
else console.error("Gemini browser test failed; a rule-based fallback does not count as success.");
process.exit(code);
