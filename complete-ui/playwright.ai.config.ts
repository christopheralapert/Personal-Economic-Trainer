import {defineConfig,devices} from "@playwright/test";
const enabled=process.env.MONEY_COACH_BROWSER_LIVE==="true";
export default defineConfig({testDir:"tests/browser",testMatch:"local-ai.spec.ts",workers:1,retries:0,maxFailures:1,
  use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",baseURL:"http://127.0.0.1:31322",trace:"retain-on-failure"},
  webServer:enabled && process.env.MONEY_COACH_BROWSER_SERVER_EXTERNAL!=="true" ? {command:"node --env-file-if-exists=../../.env scripts/preview-ai.mjs --port 31322",url:"http://127.0.0.1:31322",reuseExistingServer:false,timeout:60000} : undefined,
});
