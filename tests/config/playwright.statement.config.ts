import {defineConfig} from "@playwright/test";
import {browserTests,testResults} from "./paths";

export default defineConfig({
  testDir:browserTests,testMatch:"wise-statement.spec.ts",workers:1,
  outputDir:testResults("statement"),timeout:90000,
  use:{baseURL:"http://127.0.0.1:33111",channel:process.env.CI?undefined:"chrome",
    viewport:{width:390,height:844},serviceWorkers:"block",trace:"retain-on-failure"},
});
