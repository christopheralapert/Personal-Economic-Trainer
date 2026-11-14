import {defineConfig,devices} from "@playwright/test";
import {browserTests,testResults} from "./paths";

const port=Number(process.env.MONEYLENS_VOICE_TEST_PORT);
if(!Number.isInteger(port) || port<1 || port>65535)throw new Error("Run npm run test:web:voice to allocate a free server port.");
const origin=`http://127.0.0.1:${port}`;
export default defineConfig({
 testDir:browserTests,testMatch:"demo-voice.spec.ts",outputDir:testResults("voice"),
 workers:1,retries:0,timeout:45000,
 use:{...devices["Desktop Chrome"],channel:process.env.CI ? undefined : "chrome",viewport:{width:390,height:844},baseURL:origin,serviceWorkers:"block",trace:"retain-on-failure"},
});
