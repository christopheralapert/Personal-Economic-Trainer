import { defineConfig, devices } from "@playwright/test";

const webOrigin = "http://127.0.0.1:31311";
const apiOrigin = "http://127.0.0.1:31312";
const serverEnv = { MONEYLENS_APP_ORIGIN: webOrigin, MONEYLENS_API_URL: apiOrigin, MONEYLENS_API_PORT: "31312", MONEYLENS_DEMO_API_URL:apiOrigin, MONEYLENS_ENVIRONMENT:"test", MONEYLENS_ALLOW_DEMO:"true" };

export default defineConfig({
  testDir: "tests/browser", fullyParallel: false,
  use: { baseURL: webOrigin, ...devices["Desktop Chrome"], channel: process.env.CI ? undefined : "chrome", serviceWorkers: "allow" },
  projects: [{name:"chromium"}],
  webServer: [
    {command: "node --env-file-if-exists=.env scripts/run_api.mjs", url: `${apiOrigin}/health/ready`, env: serverEnv, reuseExistingServer: false, timeout: 30000},
    {command: "npm run start -- --port 31311", url: webOrigin, env: serverEnv, reuseExistingServer: false, timeout: 60000},
  ],
});
