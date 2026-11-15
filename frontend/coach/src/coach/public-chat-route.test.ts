import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {DefaultChatTransport,readUIMessageStream,type UIMessageChunk} from "ai";
import {COACH_REVISION,REVISION_HEADER} from "./transport";
import type {CoachMessage} from "./catalog";
import {displayedContext} from "./displayed-context";
import {createViewStore} from "@/lib/view-store";
import {money} from "@/lib/format";

const origin="http://127.0.0.1:33110",august={start:"2026-08-01",end:"2026-09-01"},july={start:"2026-07-01",end:"2026-08-01"};
const cases=[
 {locale:"en",question:"How much did I spend on taxis last month?",followup:"What about the month before?"},
 {locale:"et",question:"Kui palju kulutasin eelmisel kuul taksole?",followup:"Aga juulis 2026?"},
 {locale:"fi",question:"Paljonko käytin takseihin viime kuussa?",followup:"Entä heinäkuussa 2026?"},
] as const;
let directory:string;
beforeEach(async()=>{
 directory=await mkdtemp(path.join(os.tmpdir(),"public-chat-"));
 vi.resetModules();
 for(const [key,value] of Object.entries({MONEY_COACH_PUBLIC_GEMINI_ENABLED:"true",GEMINI_API_KEY:"test-transport-key",MONEY_COACH_PUBLIC_AI_ORIGINS:origin,MONEY_COACH_MODEL_USAGE_PATH:path.join(directory,"usage.json"),MONEY_COACH_PUBLIC_AI_BUDGET_PATH:path.join(directory,"budget.json"),MONEY_COACH_PUBLIC_AI_MAX_REQUESTS:"20"}))vi.stubEnv(key,value);
});
afterEach(async()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();await rm(directory,{recursive:true,force:true});});
function payload(question:string,locale="en",extra:Record<string,unknown>={}){
 return {dataset:"organizer1",privacy:false,locale,messages:[{role:"user",parts:[{type:"text",text:question}]}],...extra};
}
function request(body:unknown){return new Request(origin+"/api/chat",{method:"POST",headers:{origin,host:new URL(origin).host,"content-type":"application/json",[REVISION_HEADER]:COACH_REVISION},body:JSON.stringify(body)});}
function generatedReply(language:string,amount:string,followup=false){
 const month=followup?'July':'August';
 const replies:Record<string,string>={
  en:`Your recorded taxi spending in ${month} 2026 was ${amount}. These records are partial; consider whether some trips could use public transport.`,
  et:`Sinu kirjendatud taksokulud ${followup?'juulis':'augustis'} 2026 olid ${amount}. Andmed on osalised; kaalu mõne sõidu asemel ühistransporti.`,
  fi:`Kirjattuja taksimenoja oli ${followup?'heinäkuussa':'elokuussa'} 2026 yhteensä ${amount}. Tiedot ovat osittaiset; harkitse joillekin matkoille joukkoliikennettä.`,
  es:`Tus gastos registrados en taxis en agosto de 2026 fueron ${amount}. Los datos son parciales; considera el transporte público para algunos trayectos.`,
  ja:`2026年8月の記録されたタクシー代は${amount}でした。記録は一部のみです。移動によっては公共交通機関の利用を検討してみてください。`,
 };
 return replies[language];
}
function providerPayloads(network:ReturnType<typeof testTransport>){
 return network.mock.calls.map(([,init])=>{
  const body=JSON.parse(String(init?.body));
  expect(JSON.stringify(body)).not.toMatch(/MRC-|[0-9a-f]{8}-[0-9a-f-]{27,}|"(?:rows|transactions|account_id|amount_minor|balances|booked_on)"\s*:/iu);
  return {body,prompt:JSON.parse(body.contents.at(-1).parts[0].text)};
 });
}
function testTransport(){
 return vi.fn<typeof fetch>(async(url,init)=>{
  expect(String(url)).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
  const body=JSON.parse(String(init?.body)),prompt=body.contents.at(-1).parts[0].text;
  const {question,verifiedFacts,previousSelectors,previousTool}=JSON.parse(prompt);
  expect(body.generationConfig.maxOutputTokens).toBe(2048);
  const followup=cases.some(sample=>sample.followup===question);
  expect(cases.some(sample=>sample.question===question)||followup).toBe(true);
  if(followup){expect(previousSelectors).toEqual({period:august,category:"taxi"});expect(previousTool).toBe("showTransactions");}
  if(body.generationConfig.responseMimeType==='application/json'){
   expect(body.tools).toBeUndefined();expect(body.toolConfig).toBeUndefined();
   expect(verifiedFacts).toMatchObject({coverage:'partial',period:followup?july:august,amount:expect.any(String),verifiedSummary:expect.any(String)});
   const language=body.systemInstruction.parts[0].text.match(/reply in (en|et|fi|es|ja),/)?.[1];if(!language)throw new Error('Missing composition language');
   return Response.json({candidates:[{content:{role:'model',parts:[{text:JSON.stringify({text:generatedReply(language,verifiedFacts.amount,followup)})}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:80,candidatesTokenCount:30,thoughtsTokenCount:5,totalTokenCount:115}});
  }
  expect(verifiedFacts).toBeUndefined();
  expect(body.toolConfig.functionCallingConfig.mode).toBe("ANY");
  expect(body.tools[0].functionDeclarations.some((tool:{name:string})=>tool.name==="showTransactions")).toBe(true);
  return Response.json({candidates:[{content:{role:"model",parts:[{text:"Untrusted provider prose 999999 €"},{functionCall:{name:"showTransactions",args:{period:followup ? july : august,category:"taxi"}}}]},finishReason:"STOP",index:0}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:15,thoughtsTokenCount:10,totalTokenCount:125}});
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
  const response=await POST(request(payload(`Reply in ${name}. ${cases[0].question}`)));expect(response.status).toBe(200);
  expect(response.headers.get('X-Money-Coach-Evaluation')).toBe('model_conversation_tool');
  const answer=await decode(response);expect(answer.metadata).toEqual({answerMode:'model',language,generatedConversation:true});
  expect(answer.parts.find(part=>part.type==='text')).toMatchObject({type:'text',text:generatedReply(language,money(3097))});
  expect(network).toHaveBeenCalledTimes(2);expect(answer.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097,period:august}});
  expect(providerPayloads(network)[1].prompt.verifiedFacts).toMatchObject({amount:money(3097),period:august});
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
  expect(response.headers.get("X-Money-Coach-Evaluation")).toBe("model_conversation_tool");
  expect(JSON.parse(response.headers.get("X-Money-Coach-Usage")!)).toMatchObject({calls:2});
  const answer=await decode(response);
  expect(answer.metadata).toEqual({answerMode:"model",language:sample.locale,generatedConversation:true});
  const text=answer.parts.find(part=>part.type==="text");
  expect(text).toMatchObject({type:"text",text:generatedReply(sample.locale,money(3097))});
  expect(answer.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({input:{period:august,category:"taxi"},output:{period:august,filters:{category:"taxi"},netExpenses:3097}});
  expect(JSON.stringify(answer)).not.toContain("999999");
  const context=displayedContext([answer],createViewStore());expect(context).toEqual({tool:"showTransactions",input:{period:august,category:"taxi"}});
  const next=await decode(await POST(request(payload(sample.followup,sample.locale,{context}))));
  expect(next.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({input:{period:july,category:"taxi"},output:{period:july,filters:{category:"taxi"}}});
  expect(next.metadata).toEqual({answerMode:"model",language:sample.locale,generatedConversation:true});
  expect(network).toHaveBeenCalledTimes(4);
  const outbound=providerPayloads(network);
  expect(outbound[0].prompt.verifiedFacts).toBeUndefined();
  expect(outbound[1].prompt.verifiedFacts).toEqual({verifiedSummary:expect.any(String),coverage:'partial',period:august,amount:money(3097)});
  expect(outbound[2].prompt.previousSelectors).toEqual({period:august,category:'taxi'});
  expect(outbound[3].prompt.verifiedFacts.period).toEqual(july);
  const nextTool=next.parts.find(part=>part.type==='tool-showTransactions');
  if(nextTool?.type!=='tool-showTransactions'||!nextTool.output)throw new Error('Missing follow-up financial result');
  expect(outbound[3].prompt.verifiedFacts.amount).toBe(money(nextTool.output.netExpenses!));
  expect(next.parts.find(part=>part.type==='text')).toMatchObject({type:'text',text:generatedReply(sample.locale,money(nextTool.output.netExpenses!),true)});
  expect(JSON.parse(await readFile(path.join(directory,"usage.json"),"utf8"))).toMatchObject({attempts:2,completed:2,inputTokens:360,outputTokens:120,totalTokens:480});
 });
 it("keeps privacy on by default and refuses invalid scope before the provider",async()=>{
  const network=testTransport();vi.stubGlobal("fetch",network);const {POST}=await import("../../../web/app/api/chat/route");
  const body=payload(cases[0].question);delete (body as {privacy?:boolean}).privacy;
  const privateResponse=await POST(request(body));expect(privateResponse.headers.get("X-Money-Coach-Evaluation")).toBe("privacy_rule");await privateResponse.text();
  const invalid=await POST(request(payload(cases[0].followup,"en",{context:{tool:"showTransactions",input:{period:august,category:"taxi",amount:999999}}})));
  expect(invalid.status).toBe(400);expect(network).not.toHaveBeenCalled();
 });
 for(const text of [
  'Your recorded taxi spending in August 2026 was 999999 €. These records are partial.',
  'Your taxi spending in August 2026 was modest. These records are partial.',
 ])it(`rejects composed financial claims without the verified amount: ${text}`,async()=>{
  const native=testTransport(),network=vi.fn<typeof fetch>(async(url,init)=>{
   const response=await native(url,init),body=JSON.parse(String(init?.body));
   if(body.generationConfig.responseMimeType!=='application/json')return response;
   const result=await response.json();result.candidates[0].content.parts=[{text:JSON.stringify({text})}];return Response.json(result);
  });
  vi.stubGlobal('fetch',network);const {POST}=await import('../../../web/app/api/chat/route');
  const response=await POST(request(payload(cases[0].question)));
  expect(response.headers.get('X-Money-Coach-Source')).toBe('rule');
  expect(response.headers.get('X-Money-Coach-Evaluation')).toBe('conversation_ungrounded');
  const answer=await decode(response);expect(answer.metadata).toEqual({answerMode:'rule',language:'en'});
  expect(answer.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097,period:august}});
  expect(JSON.stringify(answer)).not.toContain('999999');expect(network).toHaveBeenCalledTimes(2);providerPayloads(native);
 });
 it('requires a financial tool before a reply about personal spending',async()=>{
  const network=vi.fn<typeof fetch>(async()=>Response.json({candidates:[{content:{role:'model',parts:[{functionCall:{name:'reply',args:{text:'Your taxi spending was modest.'}}}]},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:25,totalTokenCount:125}}));
  vi.stubGlobal('fetch',network);const {POST}=await import('../../../web/app/api/chat/route');
  const response=await POST(request(payload(cases[0].question)));
  expect(response.headers.get('X-Money-Coach-Evaluation')).toBe('tool_validation');
  const answer=await decode(response);expect(answer.metadata).toEqual({answerMode:'rule',language:'en'});
  expect(answer.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097,period:august}});
  expect(network).toHaveBeenCalledTimes(1);
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
