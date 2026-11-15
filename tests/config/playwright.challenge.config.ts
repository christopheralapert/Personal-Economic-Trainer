import {defineConfig} from '@playwright/test';
const origin=process.env.MONEYLENS_CHALLENGE_ORIGIN??'http://127.0.0.1:33170';
const url=new URL(origin);
if(url.origin!==origin||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Challenge checks require an explicitly isolated loopback preview.');
export default defineConfig({
 testDir:'../browser',testMatch:'challenge-acceptance.spec.ts',outputDir:'../../test-results/challenge',
 workers:1,retries:0,timeout:60000,expect:{timeout:12000},
 use:{baseURL:origin,serviceWorkers:'block',reducedMotion:'reduce',trace:'retain-on-failure'},
 projects:[
  {name:'chrome-phone',use:{browserName:'chromium',channel:'chrome',viewport:{width:390,height:844}}},
  {name:'chrome-desktop',use:{browserName:'chromium',channel:'chrome',viewport:{width:1280,height:900}}},
  {name:'webkit-phone',use:{browserName:'webkit',viewport:{width:390,height:844}}},
  {name:'webkit-desktop',use:{browserName:'webkit',viewport:{width:1280,height:900}}},
 ],
});
