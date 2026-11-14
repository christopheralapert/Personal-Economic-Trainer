import {defineConfig} from '@playwright/test';
import {browserTests,repositoryRoot,testResults} from './paths';

const existing=process.env.CONVERSATION_COACH_URL;
const origin=existing??'http://127.0.0.1:33156';
const parsed=new URL(origin);
if(parsed.origin!==origin || parsed.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(parsed.hostname))
 throw new Error('CONVERSATION_COACH_URL must be an HTTP loopback origin');
if(process.env.MONEY_COACH_REAL_CONVERSATION_TEST==='true' && !existing)
 throw new Error('Real Gemini tests require an explicitly configured production server via CONVERSATION_COACH_URL');

// Build first with MONEYLENS_NEXT_DIST=.next/conversational-coach-33156.
// An external server owns its provider configuration; this config never loads secrets.
export default defineConfig({
 testDir:browserTests,testMatch:'conversational-coach.spec.ts',
 outputDir:testResults('conversational-coach'),workers:1,retries:0,timeout:90000,
 expect:{timeout:15000},
 use:{baseURL:origin,browserName:'chromium',channel:'chrome',viewport:{width:390,height:844},
  serviceWorkers:'block',reducedMotion:'reduce',trace:'off',screenshot:'off',video:'off'},
 webServer:existing?undefined:{
  command:'node node_modules/next/dist/bin/next start frontend/web --hostname 127.0.0.1 --port 33156',
  cwd:repositoryRoot,url:origin+'/demo?dataset=organizer1&tab=coach',reuseExistingServer:false,timeout:60000,
  env:{MONEYLENS_NEXT_DIST:'.next/conversational-coach-33156',MONEYLENS_API_URL:'http://127.0.0.1:9',
   MONEY_COACH_PUBLIC_GEMINI_ENABLED:'false',MONEY_COACH_GEMINI_VOICE_ENABLED:'false',
   MONEY_COACH_LOCAL_AI_EVALUATION:'false',GEMINI_API_KEY:'',MONEYLENS_OPENAI_API_KEY:'',OPENAI_API_KEY:''},
 },
});
