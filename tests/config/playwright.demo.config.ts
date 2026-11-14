import {defineConfig,devices} from "@playwright/test";
import {browserTests,repositoryRoot,testResults} from "./paths";

const existingOrigin=process.env.MONEYLENS_DEMO_TEST_ORIGIN;
if(existingOrigin&&!/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(existingOrigin))throw new Error("Demo tests require a local HTTP origin with an explicit port.");
const origin=existingOrigin??"http://127.0.0.1:31361";
export default defineConfig({
  testDir:browserTests,testMatch:["demo-rehearsal.spec.ts","organizer-demo.spec.ts","demo-presentation.spec.ts"],
  outputDir:testResults("demo"),workers:1,retries:0,
  use:{...devices["Pixel 7"],viewport:{width:390,height:844},channel:process.env.CI?undefined:"chrome",baseURL:origin,serviceWorkers:"block",trace:"retain-on-failure"},
  webServer:existingOrigin?undefined:{
    command:"node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port 31361",
    cwd:repositoryRoot,url:`${origin}/access`,reuseExistingServer:false,timeout:60000,
    env:{MONEYLENS_API_URL:"http://127.0.0.1:9",MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false",MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEY_COACH_GEMINI_VOICE_ENABLED:"false"},
  },
});
