import {defineConfig,devices} from "@playwright/test";
import {repositoryRoot, testResults} from "./paths";

// Only the opt-in Python fixture supplies the isolated database and workers.
if (process.env.MONEYLENS_BROWSER_FINANCE !== "true") throw new Error("Run the isolated finance browser fixture; do not use the development database.");
const webOrigin="http://127.0.0.1:31321",apiOrigin="http://127.0.0.1:31322";
const env={MONEYLENS_APP_ORIGIN:webOrigin,MONEYLENS_API_URL:apiOrigin,MONEYLENS_API_PORT:"31322"};
export default defineConfig({
  testDir:"../finance-browser",outputDir:testResults("finance"),workers:1,timeout:60000,
  expect:{timeout:15000},
  use:{baseURL:webOrigin,...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",serviceWorkers:"allow"},
  webServer:[
    {command:"node --env-file-if-exists=.env scripts/run_api.mjs",cwd:repositoryRoot,url:`${apiOrigin}/health/ready`,env,reuseExistingServer:false,timeout:30000},
    {command:"npm run start -- --port 31321",cwd:repositoryRoot,url:webOrigin,env,reuseExistingServer:false,timeout:60000},
  ],
});
