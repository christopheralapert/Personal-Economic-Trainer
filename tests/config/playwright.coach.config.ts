import {defineConfig,devices} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {browserTests,repositoryRoot,testResults} from "./paths";

// Ask the OS for a free loopback port; never attach to another agent's server.
const port=process.env.MONEYLENS_COACH_TEST_PORT??=execFileSync(process.execPath,["-e","const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"],{encoding:"utf8",windowsHide:true}).trim();
const origin=`http://127.0.0.1:${port}`;
export default defineConfig({
 testDir:browserTests,testMatch:"public-coach.spec.ts",outputDir:testResults("public-coach"),workers:1,retries:0,
 use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",baseURL:origin,serviceWorkers:"block",reducedMotion:"reduce",trace:"retain-on-failure"},
 webServer:{command:`node node_modules/next/dist/bin/next dev frontend/web --webpack --hostname 127.0.0.1 --port ${port}`,cwd:repositoryRoot,url:`${origin}/demo?dataset=organizer1`,reuseExistingServer:false,timeout:120000,
  env:{MONEYLENS_NEXT_DIST:".next/coach-chat",MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false",MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEY_COACH_PUBLIC_VOICE_ENABLED:"false"}},
});
