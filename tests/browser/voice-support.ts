import {expect,test,type Page} from "@playwright/test";
import {en,fi,et} from "../../frontend/coach/src/i18n/dictionaries";

export const languages={
 fi:{copy:fi,tag:"fi-FI",draft:"Paljonko käytin takseihin viime kuus",question:"Paljonko käytin takseihin viime kuussa?"},
 et:{copy:et,tag:"et-EE",draft:"Kui palju kulutasin taksole eelmisel kuu",question:"Kui palju kulutasin taksole eelmisel kuul?"},
 en:{copy:en,tag:"en-US",draft:"How much did I spend on taxis last mont",question:"How much did I spend on taxis last month?"},
} as const;
export type Locale=keyof typeof languages;
export type Scenario="available"|"denied"|"missing"|"unsupported"|"legacy"|"remote"|"no-voice";
export type SpeechHarness={
 recognitions:Array<{lang:string;local:boolean}>;checks:Array<{langs:string[];processLocally:boolean}>;
 stops:number;aborts:number;cancels:number;media:number;tracksStopped:number;recordings:number;plays:number;pauses:number;
 spoken:Array<{text:string;lang:string;local:boolean}>;
 result:(text:string)=>void;error:(error:string)=>void;end:()=>void;finishSpeech:()=>void;settleSpeech:(index:number,failed?:boolean)=>void;settleHosted:(index:number,failed?:boolean)=>void;
};
declare global {interface Window {voiceTest:SpeechHarness}}

export async function setupVoice(page:Page,locale:Locale,scenario:Scenario="available",options:{privacy?:boolean;provider?:"browser"|"gemini"}={}){
 const traffic={external:[] as string[],audio:[] as string[],chat:[] as unknown[]};
 const origin=new URL(test.info().project.use.baseURL!).origin;
 await page.route("**/*",route=>{
  const url=new URL(route.request().url());
  if(url.protocol.startsWith("http") && url.origin!==origin){traffic.external.push(url.href);return route.abort();}
  return route.continue();
 });
 page.on("request",request=>{
  if(/\/api\/voice\/(transcribe|speak)$/.test(new URL(request.url()).pathname))traffic.audio.push(request.url());
  if(new URL(request.url()).pathname==="/api/chat")traffic.chat.push(request.postDataJSON());
 });
 // Fail closed if a test accidentally attempts a real voice upload.
 await page.route("**/api/voice/{transcribe,speak}",route=>route.abort());
 await page.addInitScript(({locale,scenario,privacy,provider})=>{
  localStorage.setItem("money-coach-privacy.v1",String(privacy));
  localStorage.setItem("money-coach-voice-provider.v1",provider);
  localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:10,savingsSource:"user"}));
  const state:SpeechHarness={recognitions:[],checks:[],stops:0,aborts:0,cancels:0,media:0,tracksStopped:0,recordings:0,plays:0,pauses:0,spoken:[],result:()=>{},error:()=>{},end:()=>{},finishSpeech:()=>{},settleSpeech:()=>{},settleHosted:()=>{}};
  window.voiceTest=state;
  class Recognition {
   static async available(options:{langs:string[];processLocally:boolean}){state.checks.push(options);return scenario==="missing" ? "unavailable" : "available";}
   lang="";interimResults=false;processLocally=false;
   onresult:((event:unknown)=>void)|null=null;onerror:((event:unknown)=>void)|null=null;onend:(()=>void)|null=null;
   constructor(){if(scenario==="legacy")delete (this as Partial<Recognition>).processLocally;}
   start(){
    state.recognitions.push({lang:this.lang,local:this.processLocally});
    state.result=text=>this.onresult?.({resultIndex:0,results:[[{transcript:text}]]});
    state.error=error=>this.onerror?.({error});state.end=()=>this.onend?.();
    if(scenario==="denied")queueMicrotask(()=>{this.onerror?.({error:"not-allowed"});this.onend?.();});
   }
   stop(){state.stops++;this.onend?.();}
   abort(){state.aborts++;this.onend?.();}
  }
  Object.defineProperty(window,"SpeechRecognition",{configurable:true,value:scenario==="unsupported" ? undefined : Recognition});
  Object.defineProperty(window,"webkitSpeechRecognition",{configurable:true,value:undefined});
  Object.defineProperty(window,"SpeechSynthesisUtterance",{configurable:true,value:class {
   text:string;lang="";voice:{localService:boolean}|null=null;onend:(()=>void)|null=null;onerror:(()=>void)|null=null;
   constructor(text:string){this.text=text;}
  }});
  const voices=scenario==="no-voice" ? [] : ["fi-FI","et-EE","en-US"].map(lang=>({lang,name:lang,localService:scenario!=="remote"}));
  const utterances:SpeechSynthesisUtterance[]=[];
  state.settleSpeech=(index,failed)=>{const utterance=utterances[index];if(failed)utterance.onerror?.({error:"interrupted"} as SpeechSynthesisErrorEvent);else utterance.onend?.({} as SpeechSynthesisEvent);};
  Object.defineProperty(window,"speechSynthesis",{configurable:true,value:{
   getVoices:()=>voices,addEventListener:()=>{},removeEventListener:()=>{},
   speak:(utterance:SpeechSynthesisUtterance)=>{utterances.push(utterance);state.spoken.push({text:utterance.text,lang:utterance.lang,local:utterance.voice?.localService===true});state.finishSpeech=()=>utterance.onend?.({} as SpeechSynthesisEvent);},
   cancel:()=>{state.cancels++;},
  }});
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:async()=>{
   state.media++;if(scenario==="denied")throw new DOMException("Denied","NotAllowedError");
   return {getTracks:()=>[{stop:()=>state.tracksStopped++}]};
  }}});
  Object.defineProperty(window,"MediaRecorder",{configurable:true,value:class {
   static isTypeSupported(type:string){return type==="audio/webm;codecs=opus";}
   state="inactive";ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;
   start(){this.state="recording";state.recordings++;}
   stop(){this.state="inactive";queueMicrotask(()=>{this.ondataavailable?.({data:new Blob(["synthetic audio"])});this.onstop?.();});}
  }});
  const players:Array<Record<string,()=>void>>=[];
  state.settleHosted=(index,failed)=>players[index][failed ? "error" : "ended"]?.();
  Object.defineProperty(window,"Audio",{configurable:true,value:class {
   callbacks:Record<string,()=>void>={};constructor(){players.push(this.callbacks);}
   addEventListener(event:string,callback:()=>void){this.callbacks[event]=callback;}async play(){state.plays++;}pause(){state.pauses++;}
  }});
 },{locale,scenario,privacy:options.privacy??true,provider:options.provider??"browser"});
 await page.emulateMedia({reducedMotion:"reduce"});
 const response=await page.goto("/demo?dataset=organizer1");
 expect(response?.status()).toBe(200);expect(response?.headers()["x-moneylens-ui"]).toBe("authenticated-home.v1");
 const {copy}=languages[locale];await expect(page.locator("header")).toContainText("30.9.2026");
 await page.getByRole("tab",{name:copy.coach,exact:true}).click();
 return traffic;
}

export const questionInput=(page:Page,locale:Locale)=>page.getByRole("textbox",{name:languages[locale].copy.questionLabel,exact:true});
export async function submitQuestion(page:Page,locale:Locale){
 const {copy,question}=languages[locale];await questionInput(page,locale).fill(question);
 const response=page.waitForResponse(value=>new URL(value.url()).pathname==="/api/chat");
 await page.getByRole("button",{name:copy.send,exact:true}).click();
 const actual=await response;expect(actual.status()).toBe(200);
 const answer=page.locator('[data-message-role="assistant"]').last();
 await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeVisible();
 return {answer,response:actual};
}

export async function mockHostedVoice(page:Page,locale:Locale){
 const transcriptions:Buffer[]=[],speeches:Record<string,unknown>[]=[];
 // Keep these mocked voice cases local even under another suite's server env.
 await page.route("**/api/chat",async route=>{
  const response=await route.fetch({postData:{...route.request().postDataJSON(),privacy:true}});
  await route.fulfill({response});
 });
 const revision=(request:import("@playwright/test").Request)=>({"x-money-coach-revision":request.headers()["x-money-coach-revision"]});
 await page.route("**/api/voice/capabilities",route=>route.fulfill({json:{enabled:true},headers:revision(route.request())}));
 await page.route("**/api/voice/transcribe",route=>{
  expect(route.request().headers()["x-money-coach-privacy"]).toBe("off");
  expect(route.request().headers()["x-money-coach-language"]).toBe(locale);
  transcriptions.push(route.request().postDataBuffer()!);
  return route.fulfill({json:{text:languages[locale].draft},headers:revision(route.request())});
 });
 await page.route("**/api/voice/speak",route=>{
  expect(route.request().headers()["x-money-coach-privacy"]).toBe("off");speeches.push(route.request().postDataJSON());
  return route.fulfill({body:Buffer.from("synthetic WAV"),contentType:"audio/wav",headers:revision(route.request())});
 });
 return {transcriptions,speeches};
}
