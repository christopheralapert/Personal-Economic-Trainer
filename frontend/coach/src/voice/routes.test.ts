import {describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createVoiceRoutes,MAX_VOICE_BYTES} from "./routes";
import {COACH_REVISION,REVISION_HEADER} from "@/coach/transport";
import {SPEECH_MODEL,TRANSCRIBE_MODEL,VOICE_ENDPOINT} from "./provider";
import {translate} from "@/i18n/translate";
import {createPublicCoachExecutor} from "@/coach/public-executor";
import {mockGeminiFetch} from "../../scripts/gemini-mock.mjs";

const origin="http://127.0.0.1:33110",signal=new AbortController().signal;
const usage={total_input_tokens:25,total_output_tokens:10,total_tokens:35};
function wav(){const b=Buffer.alloc(46);b.write("RIFF");b.writeUInt32LE(38,4);b.write("WAVE",8);return b;}
function reply(type:"text"|"audio") {return Response.json({status:"completed",steps:[{type:"model_output",content:[type==="text" ? {type:"text",text:"Paljonko käytin takseihin viime kuussa?"} : {type:"audio",mime_type:"audio/wav",data:wav().toString("base64")}]}],usage});}
function request(body:BodyInit,type="application/json",extra:Record<string,string>={}){return new Request(origin+"/api/voice/speak",{method:"POST",headers:{origin,host:"127.0.0.1:33110","Content-Type":type,[REVISION_HEADER]:COACH_REVISION,"X-Money-Coach-Privacy":"off","X-Money-Coach-Language":"fi",...extra},body,signal});}
const speech={dataset:"organizer1",locale:"fi",savingsPercent:10,tool:"showTransactions",input:{period:{start:"2026-08-01",end:"2026-09-01"},category:"taxi"}};
async function fixture(run:(env:Record<string,string>,file:string)=>Promise<void>){const directory=await mkdtemp(path.join(os.tmpdir(),"money-coach-voice-")),file=path.join(directory,"ledger.json");try{await run({GEMINI_API_KEY:"fake-voice-key",MONEY_COACH_GEMINI_VOICE_ENABLED:"true",MONEY_COACH_VOICE_LEDGER_PATH:file,MONEY_COACH_VOICE_MAX_REQUESTS:"4",MONEY_COACH_PUBLIC_AI_BUDGET_PATH:path.join(directory,"public-budget.json"),MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"20"},file);}finally{if(path.dirname(directory)!==os.tmpdir() || !path.basename(directory).startsWith("money-coach-voice-"))throw new Error("Unsafe cleanup");await rm(directory,{recursive:true,force:true});}}
describe("optional Gemini voice boundaries",()=>{
 for(const locale of ['en','fi','et'] as const)it(`sends the exact chart total and top individual categories in ${locale}`,async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(async()=>reply('audio')),routes=createVoiceRoutes({env,network});
  for(const period of [{start:'2026-09-01',end:'2026-10-01'},{start:'2026-08-01',end:'2026-09-01'}])expect((await routes.speak(request(JSON.stringify({...speech,locale,tool:'showDonut',input:{period}})))).status).toBe(200);
  const first=JSON.parse(network.mock.calls[0][1]!.body as string).input[0].content[0].text,second=JSON.parse(network.mock.calls[1][1]!.body as string).input[0].content[0].text;
  expect(first).toContain('7\u00a0017,40');expect(first).toContain('1\u00a0390,20');expect(first).toContain('884,44');expect(first).toContain({en:'Home',fi:'Koti',et:'Kodu'}[locale]);expect(first).not.toMatch(/Other categories|most of/);expect(second).not.toBe(first);
 }));
 for(const [locale,language,text] of [
  ["fi","fi-FI","Käytit takseihin elokuussa 2026 yhteensä 30,97\u00a0€."],
  ["et","et-EE","Kirjendatud netokulu (Takso): 30,97\u00a0€. Periood: august 2026."],
  ["en","en-US","Recorded net spending on Taxis: 30,97\u00a0€. Period: August 2026."],
 ] as const)it(`uses ${language} transcription and the authored ${locale} answer for hosted speech`,async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(async(_url,init)=>reply(JSON.parse(init!.body as string).model===TRANSCRIBE_MODEL ? "text" : "audio"));
  const routes=createVoiceRoutes({env,network});
  expect((await routes.transcribe(request("synthetic-audio","audio/webm",{"X-Money-Coach-Language":locale}))).status).toBe(200);
  expect(JSON.parse(network.mock.calls[0][1]!.body as string).generation_config.transcription_config.language_codes).toEqual([language]);
  expect((await routes.speak(request(JSON.stringify({...speech,locale})))).status).toBe(200);
  expect(JSON.parse(network.mock.calls[1][1]!.body as string).input[0].content).toEqual([{type:"text",text}]);
 }));
 it("blocks both audio endpoints in privacy mode before contacting a provider",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(),routes=createVoiceRoutes({env,network});
  expect((await routes.transcribe(request("synthetic-audio","audio/webm",{"X-Money-Coach-Privacy":"on"}))).status).toBe(403);
  expect((await routes.speak(request(JSON.stringify(speech),"application/json",{"X-Money-Coach-Privacy":"on"}))).status).toBe(403);
  expect(network).not.toHaveBeenCalled();
 }));
 it("refuses unmetered policy without transport or modifying prior usage",async()=>fixture(async(env,file)=>{
  env.MONEY_COACH_VOICE_REQUEST_POLICY="unmetered";env.MONEY_COACH_VOICE_MAX_REQUESTS="2";
  await writeFile(file,JSON.stringify({version:1,attempts:[{operation:"speak",at:new Date().toISOString(),status:"complete",usage},{operation:"transcribe",at:new Date().toISOString(),status:"failed"}]}));
  const network=vi.fn<typeof fetch>(async()=>reply("audio")),routes=createVoiceRoutes({env,network});
  expect((await routes.speak(request(JSON.stringify(speech)))).status).toBe(503);
  expect(await (await routes.capabilities()).json()).toMatchObject({enabled:false});
  expect(network).not.toHaveBeenCalled();expect(JSON.parse(await readFile(file,"utf8"))).toMatchObject({version:1,attempts:expect.any(Array)});
 }));
 it("never calls Google for privacy, missing opt-in, wrong origin or build",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>();const routes=createVoiceRoutes({env,network});
  for(const headers of [{"X-Money-Coach-Privacy":"on"},{"X-Money-Coach-Privacy":""},{origin:"https://other.example"},{[REVISION_HEADER]:"old"}] as Record<string,string>[])expect((await routes.speak(request(JSON.stringify(speech),"application/json",headers))).status).toBeGreaterThanOrEqual(400);
  const disabled=createVoiceRoutes({env:{...env,MONEY_COACH_GEMINI_VOICE_ENABLED:"false"},network});expect((await disabled.speak(request(JSON.stringify(speech)))).status).toBe(503);expect(await (await disabled.capabilities()).json()).toMatchObject({enabled:false});expect(network).not.toHaveBeenCalled();
 }));
 it("transcribes only bounded audio with the chosen locale, leaves usage in a private ledger",async()=>fixture(async(env,file)=>{
  const network=vi.fn<typeof fetch>(async()=>reply("text")),routes=createVoiceRoutes({env,network});
  const response=await routes.transcribe(request("synthetic-audio","audio/webm;codecs=opus"));expect(await response.json()).toMatchObject({text:"Paljonko käytin takseihin viime kuussa?",provider:"gemini"});
  const [url,init]=network.mock.calls[0];expect(url).toBe(VOICE_ENDPOINT);const body=JSON.parse(init!.body as string);expect(body).toMatchObject({model:TRANSCRIBE_MODEL,generation_config:{transcription_config:{language_codes:["fi-FI"]}}});expect(body.input[0]).toMatchObject({type:"audio",mime_type:"audio/webm"});expect(init!.redirect).toBe("error");
  const ledger=await readFile(file,"utf8");expect(JSON.parse(ledger).recent[0]).toMatchObject({operation:"transcribe",status:"complete",usage});expect(ledger).not.toContain("synthetic-audio");expect(ledger).not.toContain("Paljonko");expect(ledger).not.toContain(env.GEMINI_API_KEY);
 }));
 it("recomputes the exact visible Finnish sentence and never sends ledger rows or account IDs",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(async()=>reply("audio")),routes=createVoiceRoutes({env,network});
  const result=await routes.speak(request(JSON.stringify(speech)));expect(result.status).toBe(200);expect(result.headers.get("content-type")).toBe("audio/wav");
  const body=JSON.parse(network.mock.calls[0][1]!.body as string);expect(body.model).toBe(SPEECH_MODEL);expect(body.input[0].content).toEqual([{type:"text",text:"Käytit takseihin elokuussa 2026 yhteensä 30,97\u00a0€."}]);expect(JSON.stringify(body)).not.toMatch(/MRC-TRN|account|merchant|transactions/);
  const excluded=await routes.speak(request(JSON.stringify({...speech,scope:{excludedAccounts:[],excludedCategories:["taxi"],corrections:{}}})));expect(excluded.status).toBe(200);expect(JSON.parse(network.mock.calls[1][1]!.body as string).input[0].content).toEqual([{type:"text",text:translate("fi","emptyRecords")}]);
 }));
 it("refuses private or forged text, unknown tools, oversize and unsupported media before transport",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(),routes=createVoiceRoutes({env,network});
  for(const body of [{...speech,text:"arbitrary private text"},{...speech,dataset:"private"},{...speech,tool:"unknown"},{...speech,input:{period:{start:"bad",end:"bad"}}}])expect((await routes.speak(request(JSON.stringify(body)))).status).toBe(400);
  expect((await routes.transcribe(request("bad","text/plain"))).status).toBe(415);expect((await routes.transcribe(request(new Uint8Array(MAX_VOICE_BYTES+1),"audio/webm"))).status).toBe(413);expect(network).not.toHaveBeenCalled();
 }));
 it("retains reservations after failures and restart, caps usage and does not retry a 429",async()=>fixture(async(env,file)=>{
  env.MONEY_COACH_VOICE_MAX_REQUESTS="1";const network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:{message:"private provider error"}}),{status:429,headers:{"retry-after":"17"}}));
  const response=await createVoiceRoutes({env,network}).speak(request(JSON.stringify(speech)));expect(response.status).toBe(429);expect(response.headers.get("retry-after")).toBe("17");expect(await response.text()).not.toContain("private provider");
  const restart=createVoiceRoutes({env,network});expect(await (await restart.speak(request(JSON.stringify(speech)))).json()).toEqual({error:"voice_limit"});expect(network).toHaveBeenCalledTimes(1);expect(JSON.parse(await readFile(file,"utf8")).recent[0].status).toBe("failed");
 }));
 it("serializes competing calls and rejects malformed provider output without fallback",async()=>fixture(async(env)=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),network=vi.fn<typeof fetch>(async()=>{await gate;return Response.json({status:"completed",steps:[],usage});});
  const routes=createVoiceRoutes({env,network}),first=routes.speak(request(JSON.stringify(speech)));await vi.waitFor(()=>expect(network).toHaveBeenCalledTimes(1));
  expect(await (await routes.speak(request(JSON.stringify(speech)))).json()).toEqual({error:"public_ai_busy"});release();expect(await (await first).json()).toEqual({error:"audio_missing"});expect(network).toHaveBeenCalledTimes(1);
 }));
 it("shares the lifetime allowance between public text, transcription and speech",async()=>fixture(async(env,file)=>{
  Object.assign(env,{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"2",MONEY_COACH_PUBLIC_GEMINI_ENABLED:"true",MONEY_COACH_PUBLIC_AI_ORIGINS:origin,MONEY_COACH_MODEL_USAGE_PATH:path.join(path.dirname(file),"text-usage.json")});
  const textNetwork=vi.fn<typeof fetch>(mockGeminiFetch),voiceNetwork=vi.fn<typeof fetch>(async()=>reply("text")),execute=createPublicCoachExecutor({env,network:textNetwork}),routes=createVoiceRoutes({env,network:voiceNetwork});
  expect((await execute(request("{}"),"How much did I spend on taxis last month?","en",10,undefined,undefined,undefined,"organizer1",false)).source).toBe("model");
  expect((await routes.transcribe(request("synthetic-audio","audio/webm"))).status).toBe(200);
  const blocked=await createVoiceRoutes({env,network:voiceNetwork}).speak(request(JSON.stringify(speech)));expect(blocked.status).toBe(429);expect(await blocked.json()).toEqual({error:"public_ai_request_limit"});
  expect(textNetwork).toHaveBeenCalledTimes(2);expect(voiceNetwork).toHaveBeenCalledTimes(1);
  const before=await readFile(env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH,"utf8");expect(JSON.parse(before)).toMatchObject({requests:2});
  expect((await execute(request("{}"),"How much did I spend on taxis last month?","en",10,undefined,undefined,undefined,"organizer1",true)).diagnostic).toBe("privacy_rule");
  expect((await routes.transcribe(request("synthetic-audio","audio/webm",{"X-Money-Coach-Privacy":"on"}))).status).toBe(403);
  expect(await readFile(env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH,"utf8")).toBe(before);
 }));
 it("charges streaming speech before transport and rejects exhausted streaming requests",async()=>fixture(async(env)=>{
  Object.assign(env,{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"1",MONEY_COACH_PUBLIC_AI_BUDGET_MICRO_EUR:"100",MONEY_COACH_PUBLIC_AI_RESERVATION_MICRO_EUR:"100"});
  const events=[{event_type:"step.start",index:0,step:{type:"model_output"}},{event_type:"step.delta",index:0,delta:{type:"audio",mime_type:"audio/l16",data:Buffer.alloc(48).toString("base64")}},{event_type:"interaction.completed",interaction:{status:"completed",usage}}];
  const network=vi.fn<typeof fetch>(async(_url,init)=>{
   expect(JSON.parse(await readFile(env.MONEY_COACH_PUBLIC_AI_BUDGET_PATH,"utf8"))).toMatchObject({requests:1,reservedMicroEUR:100});
   expect(init?.cache).toBe("no-store");return new Response(events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join(""));
  }),routes=createVoiceRoutes({env,network}),streamRequest=()=>request(JSON.stringify(speech),"application/json",{accept:"application/x-money-coach-pcm"});
  const first=await routes.speak(streamRequest());expect(await first.text()).toContain('"type":"done"');
  const blocked=await createVoiceRoutes({env,network}).speak(streamRequest());expect(await blocked.text()).toContain('"error":"public_ai_request_limit"');expect(network).toHaveBeenCalledTimes(1);
 }));
 it("disables capabilities and both endpoints for malformed or missing shared grants",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>();
  for(const invalid of [{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:undefined},{MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"Infinity"},{MONEY_COACH_PUBLIC_AI_BUDGET_PATH:"relative.json"},{MONEY_COACH_VOICE_MAX_REQUESTS:"1e1"},{MONEY_COACH_VOICE_REQUEST_POLICY:"unknown"}]){
   const routes=createVoiceRoutes({env:{...env,...invalid},network});expect(await (await routes.capabilities()).json()).toMatchObject({enabled:false});
   expect((await routes.speak(request(JSON.stringify(speech)))).status).toBe(503);expect((await routes.transcribe(request("synthetic-audio","audio/webm"))).status).toBe(503);
  }
  expect(network).not.toHaveBeenCalled();
 }));
});
