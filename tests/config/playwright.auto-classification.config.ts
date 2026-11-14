import {defineConfig} from '@playwright/test';
import {browserTests,testResults} from './paths';
const origin=process.env.MONEYLENS_AUTO_CLASSIFICATION_ORIGIN??'http://127.0.0.1:33132';
if(!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))throw Error('Use an isolated loopback classification preview.');
export default defineConfig({testDir:browserTests,testMatch:'auto-classification.spec.ts',outputDir:testResults('auto-classification'),workers:1,retries:0,timeout:90000,
 use:{baseURL:origin,browserName:'chromium',channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce',trace:'off',video:'off',screenshot:'off'}});
