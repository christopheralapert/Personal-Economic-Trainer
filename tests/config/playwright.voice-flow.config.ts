import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'../browser',testMatch:'voice-flow.spec.ts',outputDir:'../../test-results/voice-flow',workers:1,retries:0,timeout:45000,use:{baseURL:process.env.VOICE_FLOW_URL??'http://127.0.0.1:33134',channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',trace:'retain-on-failure'}});
