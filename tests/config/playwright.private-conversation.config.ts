import {defineConfig} from '@playwright/test';
const origin=process.env.PRIVATE_CONVERSATION_URL??'http://127.0.0.1:33157',url=new URL(origin);
if(url.origin!==origin||url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname))throw new Error('Use an isolated loopback private preview');
export default defineConfig({testDir:'../browser',testMatch:'private-conversation.spec.ts',outputDir:'../../test-results/private-conversation',workers:1,retries:0,timeout:90000,use:{baseURL:origin,channel:'chrome',viewport:{width:390,height:844},serviceWorkers:'block',trace:'off'}});
