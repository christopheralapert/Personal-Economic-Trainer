import {defineConfig, devices} from "@playwright/test";
import {browserTests, testResults} from "./paths";

// Reuse the existing production foundation cases against the already running
// loopback-only container artifact. No host API, identity setup or model call.
export default defineConfig({
  testDir: browserTests,
  testMatch: "foundation.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30000,
  reporter: "line",
  outputDir: testResults("container"),
  use: {
    ...devices["Desktop Chrome"],
    channel: process.env.CI ? undefined : "chrome",
    baseURL: "http://127.0.0.1:33110",
    trace: "retain-on-failure",
  },
});
