import {defineConfig,devices} from "@playwright/test";
import path from "node:path";

// Keep downloaded test browsers in the ignored workspace cache, not the user's profile.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= path.resolve(__dirname,"../../.cache/playwright");
export default defineConfig({
  testDir:"tests/mobile",outputDir:"test-results/mobile",fullyParallel:false,workers:1,
  use:{baseURL:"http://127.0.0.1:31323",trace:"retain-on-failure",reducedMotion:"reduce"},
  projects:[
    {name:"android-chrome",use:{...devices["Pixel 7"],browserName:"chromium",channel:process.env.CI ? undefined : "chrome"}},
    {name:"iphone-webkit",use:{...devices["iPhone 13"],browserName:"webkit"}},
  ],
  webServer:{command:"node ../../node_modules/next/dist/bin/next start . --hostname 127.0.0.1 --port 31323",url:"http://127.0.0.1:31323",reuseExistingServer:false,timeout:60000},
});
