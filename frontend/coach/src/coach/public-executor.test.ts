import {describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,rm,access} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createPublicCoachExecutor} from "./public-executor";
import {mockGeminiFetch} from "../../scripts/gemini-mock.mjs";
import {createChatRoute} from "./chat-route";
import {COACH_REVISION,REVISION_HEADER} from "./transport";
const origin="http://127.0.0.1:33110",question="How much did I spend on taxis last month?";
const request=(site=origin)=>new Request(origin+"/api/chat",{method:"POST",headers:{host:"127.0.0.1:33110",origin:site}});
async function fixture(run:(env:Record<string,string>,file:string)=>Promise<void>){
 const directory=await mkdtemp(path.join(os.tmpdir(),"public-coach-")),file=path.join(directory,"usage.json");
 try{await run({MONEY_COACH_PUBLIC_GEMINI_ENABLED:"true",GEMINI_API_KEY:"fake-public-key",MONEY_COACH_PUBLIC_AI_ORIGINS:origin,MONEY_COACH_MODEL_USAGE_PATH:file},file);}finally{await rm(directory,{recursive:true,force:true});}
}
describe("explicitly enabled public synthetic Gemini",()=>{
 it("requires explicit privacy opt-out even when the operator has enabled the provider",async()=>fixture(async(env,file)=>{
  const network=vi.fn<typeof fetch>(),execute=createPublicCoachExecutor({env,network});
  expect((await execute(request(),question,"en",10,undefined,undefined,undefined,"organizer1")).diagnostic).toBe("privacy_rule");
  const response=await createChatRoute(execute)(new Request(origin+"/api/chat",{
   method:"POST",headers:{origin,host:"127.0.0.1:33110","Content-Type":"application/json",[REVISION_HEADER]:COACH_REVISION},
   body:JSON.stringify({dataset:"organizer1",messages:[{role:"user",parts:[{type:"text",text:question}]}]}),
  }));
  expect(response.status).toBe(200);expect(response.headers.get("X-Money-Coach-Evaluation")).toBe("privacy_rule");
  await response.text();expect(network).not.toHaveBeenCalled();await expect(access(file)).rejects.toThrow();
 }));
 it("uses validated model tools repeatedly without an OpenAI grant or request-count quota",async()=>fixture(async(env,file)=>{
  const network=vi.fn<typeof fetch>(mockGeminiFetch),execute=createPublicCoachExecutor({env,network});
  for(let i=0;i<3;i++){
   const result=await execute(request(),question,"fi",10,undefined,undefined,undefined,"organizer1",false);
   expect(result).toMatchObject({source:"model",provider:"gemini-direct",diagnostic:"model_conversation_tool",message:{metadata:{generatedConversation:true}},usageDiagnostic:{calls:2}});expect(result.message.parts[0]).toMatchObject({text:expect.stringContaining("30,97")});
   expect(result.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({input:{period:{start:'2026-08-01',end:'2026-09-01'},category:'taxi'},output:{netExpenses:3097}});
  }
  expect(network).toHaveBeenCalledTimes(6);
  for(const [index,[,init]] of network.mock.calls.entries()){
   const body=JSON.parse(String(init?.body)),prompt=JSON.parse(body.contents.at(-1).parts[0].text);
   expect(JSON.stringify(body)).not.toMatch(/MRC-|[0-9a-f]{8}-[0-9a-f-]{27,}|"(?:rows|transactions|account_id|amount_minor|balances|booked_on)"\s*:/iu);
   if(index%2===0){
    expect(body.toolConfig.functionCallingConfig.mode).toBe('ANY');expect(prompt.verifiedFacts).toBeUndefined();
    const tool=body.tools[0].functionDeclarations.find((item:{name:string})=>item.name==='showTransactions');
    expect(tool.parametersJsonSchema.properties).not.toHaveProperty('nextStep');
   }else{
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(prompt.verifiedFacts).toEqual({verifiedSummary:expect.any(String),coverage:'partial',period:{start:'2026-08-01',end:'2026-09-01'},amount:expect.stringContaining('30,97')});
   }
  }
  const ledger=await readFile(file,"utf8");expect(JSON.parse(ledger)).toMatchObject({version:2,attempts:3,completed:3,inputTokens:600,outputTokens:150,totalTokens:750});expect(ledger).not.toMatch(/fake-public-key|How much|MRC-TRN/);
 }));
 it("blocks all external calls in Privacy mode, without explicit enablement or for another origin",async()=>fixture(async(env,file)=>{
  const network=vi.fn<typeof fetch>(),execute=createPublicCoachExecutor({env,network});
  expect((await execute(request(),question,"fi",10,undefined,undefined,undefined,"organizer1",true)).diagnostic).toBe("privacy_rule");
  expect((await execute(request("https://other.example"),question,"en",10,undefined,undefined,undefined,"organizer1",false)).diagnostic).toBe("public_origin");
  expect((await createPublicCoachExecutor({env:{...env,MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false"},network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1",false)).source).toBe("rule");
  expect(network).not.toHaveBeenCalled();await expect(access(file)).rejects.toThrow();
 }));
 it("retains Google rate limits without retrying or exposing provider text",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(async()=>Response.json({error:{status:"RESOURCE_EXHAUSTED",message:"private-provider-text"}},{status:429}));
  const result=await createPublicCoachExecutor({env,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1",false);
  expect(result.source).toBe("rule");expect(result.diagnostic).toBe("provider_http:429:RESOURCE_EXHAUSTED");expect(network).toHaveBeenCalledTimes(1);expect(JSON.stringify(result)).not.toContain("private-provider-text");
 }));
 it("rejects model arguments that change the requested financial scope",async()=>fixture(async(env)=>{
  const network=vi.fn<typeof fetch>(async(url,init)=>{const body=await(await mockGeminiFetch(url,init)).json();body.candidates[0].content.parts[0].functionCall.args.category="dining";return Response.json(body);});
  const result=await createPublicCoachExecutor({env,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1",false);
  expect(result.source).toBe("rule");expect(result.diagnostic).toBe("tool_validation");expect(network).toHaveBeenCalledTimes(1);
 }));
});
