import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {DefaultChatTransport,readUIMessageStream,type UIMessageChunk} from "ai";
import {COACH_REVISION,REVISION_HEADER} from "./transport";
import type {CoachMessage} from "./catalog";
import {displayedContext} from "./displayed-context";
import {createViewStore} from "@/lib/view-store";

const origin="http://127.0.0.1:33110",august={start:"2026-08-01",end:"2026-09-01"},july={start:"2026-07-01",end:"2026-08-01"};
const cases=[
 {locale:"en",question:"How much did I spend on taxis last month?",followup:"What about the month before?",framing:"30,97 € in recorded taxi expenses."},
 {locale:"et",question:"Kui palju kulutasin eelmisel kuul taksole?",followup:"Aga juulis 2026?",framing:"30,97 € kirjendatud taksokulusid."},
 {locale:"fi",question:"Paljonko käytin takseihin viime kuussa?",followup:"Entä heinäkuussa 2026?",framing:"30,97 € kirjattuja taksimenoja."},
] as const;
let directory:string;
beforeEach(async()=>{
 directory=await mkdtemp(path.join(os.tmpdir(),"public-chat-"));
 vi.resetModules();
 for(const [key,value] of Object.entries({MONEY_COACH_PUBLIC_GEMINI_ENABLED:"true",GEMINI_API_KEY:"test-transport-key",MONEY_COACH_PUBLIC_AI_ORIGINS:origin,MONEY_COACH_MODEL_USAGE_PATH:path.join(directory,"usage.json")}))vi.stubEnv(key,value);
});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
function payload(question:string,locale="en",extra:Record<string,unknown>={}){
 return {dataset:"organizer1",privacy:false,locale,messages:[{role:"user",parts:[{type:"text",text:question}]}],...extra};
}
function request(body:unknown){return new Request(origin+"/api/chat",{method:"POST",headers:{origin,host:new URL(origin).host,"content-type":"application/json",[REVISION_HEADER]:COACH_REVISION},body:JSON.stringify(body)});}
function testTransport(){
 return vi.fn<typeof fetch>(async(url,init)=>{
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
  const body=JSON.parse(String(init?.body)),prompt=body.contents.at(-1).parts[0].text;
  let question=prompt;try{question=JSON.parse(prompt).question;}catch{}
  expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
  expect(body.tools[0].functionDeclarations.some((tool:{name:string})=>tool.name==="showTransactions")).toBe(true);
  expect(body.generationConfig.maxOutputTokens).toBe(2048);
  const followup=cases.some(sample=>sample.followup===question);
  expect(cases.some(sample=>sample.question===question)||followup).toBe(true);
  if(followup)expect(JSON.parse(prompt).previousSelectors).toEqual({tool:"showTransactions",input:{period:august,category:"taxi"}});
  return Response.json({candidates:[{content:{role:"model",parts:[{text:"Untrusted provider prose 999999 €"},{functionCall:{name:"showTransactions",args:{period:followup ? july : august,category:"taxi",nextStep:'Review the matching records before choosing a habit to change.'}}}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,thoughtsTokenCount:10,totalTokenCount:125}});
 });
}
async function decode(response:Response){
 // Use the same SDK decoding as useChat, including tool inputs and metadata.
 const transport=new DefaultChatTransport<CoachMessage>({api:origin+"/api/chat",fetch:async()=>response});
 const stream=await transport.sendMessages({trigger:"submit-message",chatId:"test",messageId:undefined,messages:[],abortSignal:undefined});
 let answer:CoachMessage|undefined;
 for await(const message of readUIMessageStream<CoachMessage>({stream:stream as ReadableStream<UIMessageChunk>,onError:error=>{throw error;}}))answer=message;
 if(!answer)throw new Error("Missing streamed answer");return answer;
}

describe("main web /api/chat with native Gemini test transport",()=>{
 for(const [language,name] of [['es','Spanish'],['ja','Japanese']] as const)it(`keeps validated financial results when a one-answer ${language} command is present`,async()=>{
  const network=testTransport();vi.stubGlobal('fetch',network);const {POST}=await import('../../../web/app/api/chat/route');
  const response=await POST(request(payload(`Reply in ${name}. ${cases[0].question}`)));expect(response.status).toBe(200);const answer=await decode(response);expect(answer.metadata).toEqual({answerMode:'model',language,generatedGuidance:true});expect(network).toHaveBeenCalledTimes(1);expect(answer.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097,period:august}});
 });
 it('acknowledgements and unsupported private languages never call a model',async()=>{
  const network=vi.fn<typeof fetch>();vi.stubGlobal('fetch',network);const {POST}=await import('../../../web/app/api/chat/route');
  for(const body of [payload('Thank you'),payload(cases[0].question,'en',{privacy:true,conversationLanguage:'ja'})]){const response=await POST(request(body));expect(response.status).toBe(200);expect(response.headers.get('X-Money-Coach-Source')).toBe('rule');expect((await decode(response)).parts.some(part=>part.type.startsWith('tool-'))).toBe(false);}expect(network).not.toHaveBeenCalled();
 });
 for(const sample of cases)it(`streams grounded ${sample.locale} tools and follow-up selectors`,async()=>{
  const network=testTransport();vi.stubGlobal("fetch",network);
  const {POST}=await import("../../../web/app/api/chat/route");
  const response=await POST(request(payload(sample.question,sample.locale)));
  expect(response.status).toBe(200);expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("X-Money-Coach-Provider")).toBe("gemini-direct");
  expect(response.headers.get("X-Money-Coach-Evaluation")).toBe("model_tool");
  const answer=await decode(response);
  expect(answer.metadata).toEqual({answerMode:"model",language:sample.locale,generatedGuidance:true});
  const text=answer.parts.find(part=>part.type==="text");
  expect(text?.type==="text" ? text.text.replaceAll("\u00a0"," ") : undefined).toBe(sample.framing);
  expect(answer.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({input:{period:august,category:"taxi"},output:{period:august,filters:{category:"taxi"},netExpenses:3097}});
  expect(JSON.stringify(answer)).not.toContain("999999");
  const context=displayedContext([answer],createViewStore());expect(context).toEqual({tool:"showTransactions",input:{period:august,category:"taxi"}});
  const next=await decode(await POST(request(payload(sample.followup,sample.locale,{context}))));
  expect(next.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({input:{period:july,category:"taxi"},output:{period:july,filters:{category:"taxi"}}});
  expect(network).toHaveBeenCalledTimes(2);
  expect(JSON.parse(await readFile(path.join(directory,"usage.json"),"utf8"))).toMatchObject({attempts:2,completed:2,totalTokens:250});
 });
 it("keeps privacy on by default and refuses invalid scope before the provider",async()=>{
  const network=testTransport();vi.stubGlobal("fetch",network);const {POST}=await import("../../../web/app/api/chat/route");
  const body=payload(cases[0].question);delete (body as {privacy?:boolean}).privacy;
  const privateResponse=await POST(request(body));expect(privateResponse.headers.get("X-Money-Coach-Evaluation")).toBe("privacy_rule");await privateResponse.text();
  const invalid=await POST(request(payload(cases[0].followup,"en",{context:{tool:"showTransactions",input:{period:august,category:"taxi",amount:999999}}})));
  expect(invalid.status).toBe(400);expect(network).not.toHaveBeenCalled();
 });
 it("streams a grounded local answer when Gemini fails, without retrying or exposing its error",async()=>{
  const network=vi.fn<typeof fetch>(async()=>Response.json({error:{status:"RESOURCE_EXHAUSTED",message:"private provider details"}},{status:429}));
  vi.stubGlobal("fetch",network);const {POST}=await import("../../../web/app/api/chat/route");
  const response=await POST(request(payload(cases[2].question,"fi")));
  expect(response.status).toBe(200);expect(response.headers.get("X-Money-Coach-Source")).toBe("rule");
  expect(response.headers.get("X-Money-Coach-Provider")).toBeNull();
  expect(response.headers.get("X-Money-Coach-Evaluation")).toBe("provider_http:429:RESOURCE_EXHAUSTED");
  const answer=await decode(response);expect(answer.metadata).toEqual({answerMode:"rule",language:"fi"});
  expect(answer.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({output:{netExpenses:3097,period:august}});
  expect(JSON.stringify(answer)).not.toContain("private provider details");expect(network).toHaveBeenCalledTimes(1);
 });
});
