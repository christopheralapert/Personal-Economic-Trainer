import {defineConfig,devices} from "@playwright/test";
import {readFileSync} from "node:fs";
import path from "node:path";

// Exercise the actual running frontend, never a replacement test server.
const origin=process.env.MONEY_COACH_PUBLIC_ORIGIN??"http://127.0.0.1:33110";
const build=readFileSync(path.join(__dirname,"../web/.next/BUILD_ID"),"utf8").trim();
export default defineConfig({
 testDir:"tests/browser",testMatch:"speech-privacy.spec.ts",outputDir:"test-results/public-voice",workers:1,retries:0,
 metadata:{demoPath:"/demo",publicBuild:build},
 use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",baseURL:origin,
  serviceWorkers:"allow",extraHTTPHeaders:{"ngrok-skip-browser-warning":"true"},trace:"retain-on-failure"},
});
