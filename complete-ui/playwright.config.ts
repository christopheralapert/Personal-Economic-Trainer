import {defineConfig,devices} from "@playwright/test";
export default defineConfig({testDir:"tests/browser",outputDir:"test-results/browser",fullyParallel:false,workers:1,
  use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",baseURL:"http://127.0.0.1:31321",trace:"retain-on-failure"},
  webServer:{command:"node ../node_modules/next/dist/bin/next start . --hostname 127.0.0.1 --port 31321",url:"http://127.0.0.1:31321",reuseExistingServer:false,timeout:60000},
});
