import {defineConfig} from '@playwright/test';
const origin=process.env.MONEYLENS_CHALLENGE_ORIGIN??'http://127.0.0.1:33170';
const url=new URL(origin);
if(url.origin!==origin||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Planning UI checks require a loopback production preview.');
export default defineConfig({testDir:'../browser',testMatch:'planning.spec.ts',outputDir:'../../test-results/planning-review',workers:1,retries:0,timeout:45000,use:{baseURL:origin,channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',trace:'retain-on-failure'}});
