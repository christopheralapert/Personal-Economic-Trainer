import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'../browser',testMatch:'demo-import.spec.ts',outputDir:'../../test-results/demo-import',workers:1,retries:0,timeout:45000,use:{baseURL:process.env.MONEYLENS_IMPORT_DEMO_ORIGIN??'http://127.0.0.1:33142',channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',trace:'retain-on-failure'}});
