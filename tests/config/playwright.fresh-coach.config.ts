import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'../browser',testMatch:'fresh-coach.spec.ts',outputDir:'../../test-results/fresh-coach',workers:1,retries:0,timeout:90000,use:{baseURL:process.env.FRESH_COACH_URL??'http://127.0.0.1:33152',channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',trace:'off'}});
