import {defineConfig} from "@playwright/test";
import {browserTests,repositoryRoot,testResults} from "./paths";
const existing=process.env.MONEYLENS_COMPACT_ORIGIN,origin=existing??"http://127.0.0.1:33130";
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error("Use a loopback compact-copy preview");
export default defineConfig({testDir:browserTests,testMatch:"compact-demo-copy.spec.ts",outputDir:testResults("compact-copy"),workers:1,retries:0,timeout:60000,
 use:{baseURL:origin,browserName:"chromium",channel:"chrome",serviceWorkers:"block",reducedMotion:"reduce",trace:"off"},
 projects:[{name:"mobile",use:{viewport:{width:390,height:844}}},{name:"desktop",grep:/en: compact/,use:{viewport:{width:1280,height:900}}}],
 webServer:existing?undefined:{command:"node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port 33130",cwd:repositoryRoot,url:origin+"/demo?dataset=organizer1",reuseExistingServer:false,timeout:60000,
 env:{MONEYLENS_NEXT_DIST:".next/compact-copy-33130",MONEYLENS_API_URL:"http://127.0.0.1:9",MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false",MONEY_COACH_GEMINI_VOICE_ENABLED:"false",MONEY_COACH_LOCAL_AI_EVALUATION:"false"}}
});
