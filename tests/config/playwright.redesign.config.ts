import {defineConfig,devices} from "@playwright/test";
import {execFileSync} from "node:child_process";
import {browserTests,repositoryRoot,testResults} from "./paths";
const existing=process.env.MONEYLENS_REDESIGN_TEST_ORIGIN;
if(existing&&!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(existing))throw new Error("Redesign tests require a local loopback origin.");
const port=existing?new URL(existing).port:execFileSync(process.execPath,["-e","const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});"],{encoding:"utf8",windowsHide:true}).trim();
const origin=existing??`http://127.0.0.1:${port}`;
export default defineConfig({
 testDir:browserTests,testMatch:["learn.spec.ts","demo-rehearsal.spec.ts","organizer-demo.spec.ts","demo-presentation.spec.ts","demo-keyboard.spec.ts","public-coach.spec.ts","demo-voice.spec.ts","private-records.spec.ts","classification-review.spec.ts","wise-statement.spec.ts"],
 outputDir:testResults("redesign"),workers:1,retries:0,timeout:45000,
 use:{...devices["Desktop Chrome"],channel:process.env.CI?undefined:"chrome",baseURL:origin,viewport:{width:390,height:844},serviceWorkers:"block",reducedMotion:"reduce",trace:"retain-on-failure"},
 webServer:existing?undefined:{command:`node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port ${port}`,cwd:repositoryRoot,url:`${origin}/demo?dataset=organizer1`,reuseExistingServer:false,timeout:60000,env:{MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false",MONEY_COACH_PUBLIC_VOICE_ENABLED:"false",MONEY_COACH_GEMINI_VOICE_ENABLED:"false",MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEYLENS_API_URL:"http://127.0.0.1:9"}},
});
