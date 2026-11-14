import {defineConfig} from "@playwright/test";
import {browserTests,testResults} from "./paths";
process.env.PLAYWRIGHT_NO_COPY_PROMPT="1";
const origin=process.env.MONEYLENS_GUARD_ORIGIN,api=process.env.MONEYLENS_GUARD_API;
for(const value of[origin,api])if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(value??""))throw Error("Set explicit isolated amount-guard loopback origins");
export default defineConfig({testDir:browserTests,testMatch:"amount-guard.spec.ts",outputDir:testResults("amount-guard"),workers:1,retries:0,timeout:90000,use:{baseURL:origin,browserName:"chromium",channel:"chrome",viewport:{width:390,height:844},serviceWorkers:"block",reducedMotion:"reduce",trace:"off"}});
