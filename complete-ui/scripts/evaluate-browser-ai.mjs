import {spawn} from "node:child_process";
import {fileURLToPath} from "node:url";
const args=process.argv.slice(2),organizer=args.join(" ")==="--live --organizer";
if(args.join(" ")!=="--live"&&!organizer) {console.log("No request made. Use --live [--organizer] only with a current origin/revision-bound local evaluation grant.");process.exit(2);}
const app=fileURLToPath(new URL("../",import.meta.url));
const cli=fileURLToPath(new URL("../../node_modules/@playwright/test/cli.js",import.meta.url));
const child=spawn(process.execPath,[cli,"test","--config","playwright.ai.config.ts"],{cwd:app,windowsHide:true,stdio:"inherit",env:{...process.env,MONEY_COACH_BROWSER_LIVE:"true",MONEY_COACH_ORGANIZER_SMOKE:organizer?"true":"false"}});
const stop=()=>child.kill();process.once("SIGINT",stop);process.once("SIGTERM",stop);
child.once("error",()=>{console.log("Local browser evaluation could not start.");process.exitCode=1;});
child.once("exit",code=>{process.exitCode=code ?? 1;});
