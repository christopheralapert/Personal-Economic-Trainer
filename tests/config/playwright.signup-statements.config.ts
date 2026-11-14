import {defineConfig,devices} from "@playwright/test";
import {browserTests,testResults} from "./paths";
const origin=process.env.MONEYLENS_SIGNUP_BROWSER_ORIGIN;
if(!origin||!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))throw new Error("Start an isolated self-signup rehearsal and set its loopback MONEYLENS_SIGNUP_BROWSER_ORIGIN.");
export default defineConfig({testDir:browserTests,testMatch:"signup-statements.spec.ts",outputDir:testResults("signup-statements"),workers:1,retries:0,timeout:180000,
 use:{...devices["Desktop Chrome"],channel:process.env.CI?undefined:"chrome",baseURL:origin,viewport:{width:390,height:844},serviceWorkers:"block",reducedMotion:"reduce",trace:"retain-on-failure"},
});
