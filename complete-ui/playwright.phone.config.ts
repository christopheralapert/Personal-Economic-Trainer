import {defineConfig} from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir:"tests/phone-browser",outputDir:"test-results/phone",fullyParallel:false,workers:1,
  use:{baseURL:"https://127.0.0.1:31324",trace:"retain-on-failure"},
  // HTTP bootstrap readiness avoids bypassing TLS in the test runner itself.
  webServer:{command:"node apps/money-coach/scripts/preview-phone.mjs --host 127.0.0.1 --port 31324 --setup-port 31325",cwd:path.resolve(__dirname,"../.."),url:"http://127.0.0.1:31325",reuseExistingServer:false,timeout:60000},
});
