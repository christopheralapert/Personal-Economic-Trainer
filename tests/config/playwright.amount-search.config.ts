import {defineConfig} from '@playwright/test';
const origin=process.env.MONEYLENS_AMOUNT_SEARCH_ORIGIN??'http://127.0.0.1:33171';
if(!/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin))throw new Error('Amount-search checks require a dedicated loopback preview');
export default defineConfig({testDir:'../browser',testMatch:'amount-search.spec.ts',outputDir:'../../test-results/amount-search',workers:1,retries:0,timeout:90000,expect:{timeout:12000},use:{baseURL:origin,browserName:'chromium',channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce',trace:'off',screenshot:'off'}});
