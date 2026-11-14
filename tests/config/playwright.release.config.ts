import {defineConfig} from "@playwright/test";
import {browserTests,testResults} from "./paths";
const origin=process.env.MONEYLENS_RELEASE_ORIGIN;
if(!origin||!/^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/.test(origin))throw Error("Set a dedicated loopback production rehearsal origin; synthetic signed OIDC only.");
const common={baseURL:origin,serviceWorkers:"block" as const,reducedMotion:"reduce" as const,trace:"retain-on-failure" as const};
export default defineConfig({testDir:browserTests,outputDir:testResults("release"),workers:1,retries:0,timeout:90000,
 projects:[
  {name:"recovery",testMatch:"release-recovery.spec.ts",use:{...common,browserName:"chromium",channel:"chrome",viewport:{width:390,height:844}}},
  {name:"real-gemini",testMatch:"release-gemini.spec.ts",use:{...common,browserName:"chromium",channel:"chrome",viewport:{width:390,height:844}}},
  {name:"scope",testMatch:"release-scope.spec.ts",use:{...common,browserName:"chromium",channel:"chrome",viewport:{width:390,height:844}}},
  ...(["chromium","webkit"] as const).flatMap(browserName=>["mobile","desktop"].map(size=>({name:`${browserName}-${size}`,testMatch:"release-compatibility.spec.ts",use:{...common,browserName,channel:browserName==="chromium"?"chrome":undefined,viewport:size==="mobile"?{width:390,height:844}:{width:1280,height:900}}})))
 ]});
