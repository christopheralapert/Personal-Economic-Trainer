import {defineConfig,devices} from "@playwright/test";
import path from "node:path";
const artifact=process.env.MONEY_COACH_RELEASE_DIR;
if(!artifact || !path.isAbsolute(artifact)) throw new Error("Set MONEY_COACH_RELEASE_DIR to an extracted verified release");
export default defineConfig({testDir:"tests/browser",testMatch:"money-coach.spec.ts",outputDir:"test-results/release",workers:1,
 use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",baseURL:"http://127.0.0.1:31325",trace:"retain-on-failure"},
 webServer:{command:`"${process.execPath}" run-demo.mjs --port 31325`,cwd:artifact,url:"http://127.0.0.1:31325",reuseExistingServer:false,timeout:60000,
 env:{MONEY_COACH_LOCAL_AI_EVALUATION:"true",OPENAI_API_KEY:"fixture-not-a-key"}},
});
