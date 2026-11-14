import {defineConfig} from "@playwright/test";
import {browserTests,testResults} from "./paths";
for(const name of["MONEYLENS_NORMAL_ORIGIN","MONEYLENS_CONFIG_TEST_ORIGIN","MONEYLENS_CONFIG_TEST_API"]){if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env[name]??""))throw Error("Set explicit loopback configuration rehearsal URLs");}
export default defineConfig({testDir:browserTests,testMatch:"deployment-modes.spec.ts",outputDir:testResults("deployment-modes"),workers:1,retries:0,timeout:30000,use:{browserName:"chromium",channel:"chrome",viewport:{width:390,height:844},serviceWorkers:"block",trace:"retain-on-failure"}});
