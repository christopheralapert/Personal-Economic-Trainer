import {defineConfig} from "@playwright/test";
import {browserTests, testResults} from "./paths";
export default defineConfig({testDir:browserTests,testMatch:"first-login-issuer.spec.ts",workers:1,
 outputDir:testResults("first-login"),use:{baseURL:process.env.MONEYLENS_FIRST_LOGIN_BROWSER_ORIGIN??"http://127.0.0.1:33110",
 channel:process.env.CI?undefined:"chrome",viewport:{width:390,height:844},serviceWorkers:"block",trace:"retain-on-failure"}});
