import {describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,writeFile,rm,access} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {createCoachExecutor} from "./server-executor";
import {COACH_REVISION} from "./transport";
import {CoachCancelledError} from "./execution";
import {openBudget,keyFingerprint,MODEL,DAILY_TOKENS,MAX_ATTEMPTS,MAX_COST_MICRO_EUR,REQUEST_RESERVATION} from "../../scripts/live-budget.mjs";
import {mockGeminiFetch} from "../../scripts/gemini-mock.mjs";
import {createOpenAI} from "@ai-sdk/openai";
import {LLMProvider} from "./llm-provider";
import {loadDataset} from "@/engine/datasets";

const origin="http://127.0.0.1:3001",question="How much did I spend on taxis last month?";
const request=(signal?:AbortSignal)=>new Request(origin+"/api/chat",{method:"POST",headers:{host:"127.0.0.1:3001",origin},signal});
function response(category="taxi") {
  const chunk=(delta:unknown,finish_reason:string|null)=>({id:"local-server-sdk",object:"chat.completion.chunk",created:0,model:MODEL,choices:[{index:0,delta,finish_reason}]});
  const frames=[chunk({role:"assistant",tool_calls:[{index:0,id:"local-call",type:"function",function:{name:"showTransactions",arguments:JSON.stringify({period:{start:"2026-10-01",end:"2026-11-01"},category})}}]},null),{...chunk({},"tool_calls"),usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}}];
  return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
}
async function fixture(run:(context:{env:Record<string,string|undefined>;file:string;read:()=>Promise<Record<string,unknown>>})=>Promise<void>) {
  const directory=await mkdtemp(path.join(os.tmpdir(),"money-coach-executor-")),file=path.join(directory,"allowance.json"),key="fake-local-server-test-key";
  const state={version:1,model:MODEL,dailyTokens:DAILY_TOKENS,maxAttempts:MAX_ATTEMPTS,maximumCostMicroEUR:MAX_COST_MICRO_EUR,paidEvaluationAuthorized:true,
    keyFingerprint:keyFingerprint(key),sharingConfirmed:true,exclusiveUsageConfirmed:true,initialUsageTokens:0,
    confirmedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),attempts:[],interactiveOrigin:origin,interactiveRevision:COACH_REVISION};
  await writeFile(file,JSON.stringify(state));
  const env={MONEY_COACH_LOCAL_AI_EVALUATION:"true",MONEY_COACH_LOCAL_AI_ORIGIN:origin,MONEY_COACH_EVALUATION_DIRECTORY:directory,MONEYLENS_OPENAI_API_KEY:key,MONEYLENS_MODEL_BILLING_POLICY:"free_only"};
  try {await run({env,file,read:async()=>JSON.parse(await readFile(file,"utf8"))});} finally {
    if(path.dirname(path.resolve(directory))!==path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("money-coach-executor-")) throw new Error("Unsafe cleanup target");
    await rm(directory,{recursive:true,force:true});
  }
}

describe("server-only local model composition",()=>{
  it("Gemini uses the local organizer data without the OpenAI grant and rejects other origins or data",async()=>fixture(async({env})=>{
    const settings={...env,MONEY_COACH_LOCAL_GEMINI:"true",GEMINI_API_KEY:"fake-key",MONEYLENS_MODEL_BILLING_POLICY:"paid",MONEY_COACH_EVALUATION_DIRECTORY:undefined};
    const network=vi.fn<typeof fetch>(mockGeminiFetch),open=vi.fn(openBudget),execute=createCoachExecutor({env:settings,network,open});
    const result=await execute(request(),question,"en",10,undefined,undefined,undefined,"organizer1");
    expect(result.source).toBe("model");expect(result.message.parts[0]).toMatchObject({text:expect.stringContaining("30,97")});
    expect(network).toHaveBeenCalledTimes(1);expect(open).not.toHaveBeenCalled();
    expect((await execute(request(),question,"en",10,undefined,undefined,undefined,"starter")).source).toBe("rule");
    const remote=new Request(origin+"/api/chat",{method:"POST",headers:{host:"127.0.0.1:3001",origin:"https://public.example"}});
    expect((await execute(remote,question,"en",10,undefined,undefined,undefined,"organizer1")).source).toBe("rule");
    expect(network).toHaveBeenCalledTimes(1);
  }));
  it("reports a Gemini provider rate limit without exposing provider details",async()=>fixture(async({env})=>{
    const settings={...env,MONEY_COACH_LOCAL_GEMINI:"true",GEMINI_API_KEY:"fake-key"};
    const network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:{status:"RESOURCE_EXHAUSTED",message:"private provider details"}}),{status:429}));
    const result=await createCoachExecutor({env:settings,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1");
    expect(result.source).toBe("rule");expect(result.diagnostic).toBe("provider_http:429:RESOURCE_EXHAUSTED");expect(JSON.stringify(result)).not.toContain("private provider details");
  }));
  it("rejects a non-streaming Gemini tool call that changes the requested category",async()=>fixture(async({env})=>{
    const settings={...env,MONEY_COACH_LOCAL_GEMINI:"true",GEMINI_API_KEY:"fake-key"};
    const network=vi.fn<typeof fetch>(async(url,init)=>{
      const reply=await mockGeminiFetch(url,init);const body=await reply.json();
      body.candidates[0].content.parts[0].functionCall.args.category="dining";
      return Response.json(body);
    });
    const result=await createCoachExecutor({env:settings,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1");
    expect(network).toHaveBeenCalledTimes(1);expect(result.source).toBe("rule");expect(result.diagnostic).toBe("tool_validation");
  }));
  it("identifies invalid native Gemini arguments without publishing a tool result",async()=>fixture(async({env})=>{
    const settings={...env,MONEY_COACH_LOCAL_GEMINI:"true",GEMINI_API_KEY:"fake-key"};
    const network=vi.fn<typeof fetch>(async(url,init)=>{const data=await (await mockGeminiFetch(url,init)).json();data.candidates[0].content.parts[0].functionCall.args.category=123;return Response.json(data);});
    const result=await createCoachExecutor({env:settings,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1");
    expect(result.source).toBe("rule");expect(result.diagnostic).toBe("tool_validation");
  }));
  it("reports only fixed diagnostic labels for a Gemini 400 tool-schema rejection",async()=>fixture(async({env})=>{
    const settings={...env,MONEY_COACH_LOCAL_GEMINI:"true",GEMINI_API_KEY:"fake-key"};
    const network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:{type:"invalid_request_error",message:"Bad schema SECRET_DO_NOT_PRINT"}}),{status:400}));
    const result=await createCoachExecutor({env:settings,network})(request(),question,"en",10,undefined,undefined,undefined,"organizer1");
    expect(result.source).toBe("rule");expect(result.diagnostic).toBe("provider_http:400:invalid_request_error:tool_schema");
    expect(JSON.stringify(result)).not.toContain("SECRET_DO_NOT_PRINT");
  }));
  it("identifies a malformed provider tool delta without disclosing its contents",async()=>fixture(async({env})=>{
    const chunk={id:"mock",object:"chat.completion.chunk",created:0,model:"gemini-3.5-flash",choices:[{index:0,delta:{tool_calls:[{function:{name:"SECRET",arguments:"{}"}}]},finish_reason:null}]};
    const network=vi.fn<typeof fetch>(async()=>new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}}));
    const model=createOpenAI({apiKey:env.MONEYLENS_OPENAI_API_KEY,fetch:network}).chat("fake-model");
    const result=await new LLMProvider(model).answerWithOutcome(question,"en",10,{data:await loadDataset("organizer1")});
    expect(result.source).toBe("rule");expect(result.failureStage).toContain("AI_TypeValidationError_tool_index");expect(JSON.stringify(result)).not.toContain("SECRET");
  }));
  it("admits only a paired private HTTPS phone under a one-hour 20-additional-call grant",async()=>fixture(async({env,file,read})=>{
    const phoneOrigin="https://192.168.1.101:8443",secret="a".repeat(64),initial=await read();
    const attempts=Array.from({length:40},(_,index)=>({id:`prior-${index}`,status:"completed",countedTokens:125,countedCostMicroEUR:160,inputTokens:100,outputTokens:25}));
    const now=new Date();await writeFile(file,JSON.stringify({...initial,attempts,phoneEvaluationAuthorized:true,phoneStartAttempts:40,maxAttempts:60,interactiveOrigin:phoneOrigin,confirmedAt:now.toISOString(),expiresAt:new Date(now.getTime()+3600000).toISOString()}));
    const settings={...env,MONEY_COACH_LOCAL_AI_ORIGIN:phoneOrigin,MONEY_COACH_PHONE_AI_EVALUATION:"true",MONEY_COACH_PHONE_AI_SECRET:secret};
    const network=vi.fn<typeof fetch>(async()=>response()),execute=createCoachExecutor({env:settings,network});
    const phoneRequest=(cookie:string)=>new Request("http://localhost:8443/api/chat",{method:"POST",headers:{host:"192.168.1.101:8443",origin:phoneOrigin,cookie}});
    for(const cookie of ["",`__Host-coach-evaluation=${"b".repeat(64)}`,`__Host-coach-evaluation=${"ä".repeat(64)}`]) expect((await execute(phoneRequest(cookie),question,"en",10)).source).toBe("rule");
    expect(network).not.toHaveBeenCalled();
    expect((await execute(phoneRequest(`__Host-coach-evaluation=${secret}`),question,"en",10)).source).toBe("model");
    expect(network).toHaveBeenCalledTimes(1);expect((await read()).attempts).toHaveLength(41);
    const current=await read();await writeFile(file,JSON.stringify({...current,attempts:[...attempts,...Array.from({length:20},(_,index)=>({...attempts[0],id:`extra-${index}`}))]}));
    await execute(phoneRequest(`__Host-coach-evaluation=${secret}`),question,"en",10);expect(network).toHaveBeenCalledTimes(1);
  }));
  it("a key/legacy flag or remote/missing/mismatched origin never opens the budget or calls a provider",async()=>fixture(async({env})=>{
    const open=vi.fn(openBudget),network=vi.fn<typeof fetch>();
    for(const [settings,input] of [
      [{...env,MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEY_COACH_LLM_ENABLED:"true"},request()],
      [{...env,MONEY_COACH_LOCAL_AI_ORIGIN:"https://public.example"},request()],
      [{...env,MONEYLENS_MODEL_BILLING_POLICY:"paid_allowed"},request()],
      [{...env,MONEY_COACH_EVALUATION_DIRECTORY:"relative"},request()],
      [env,new Request(origin+"/api/chat",{method:"POST",headers:{host:"127.0.0.1:3001"}})],
      [env,new Request(origin+"/api/chat",{method:"POST",headers:{host:"127.0.0.1:3001",origin:"https://untrusted.example"}})],
      [env,new Request("http://localhost:3001/api/chat",{method:"POST",headers:{host:"localhost:3001",origin}})],
    ] as const) {
      expect((await createCoachExecutor({env:settings,open,network})(input,question,"en",10)).source).toBe("rule");
    }
    expect(open).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
  }));

  it("real durable grant and actual SDK return grounded output, settle usage and release the lock",async()=>fixture(async({env,read})=>{
    const network=vi.fn<typeof fetch>(async()=>response());
    const result=await createCoachExecutor({env,network})(request(),question,"en",10);
    expect(result.source).toBe("model");expect(result.message.parts[0]).toMatchObject({text:expect.stringContaining("40,00")});
    expect(network).toHaveBeenCalledTimes(1);expect((await read()).attempts).toMatchObject([{status:"completed",countedTokens:125}]);
    expect(JSON.stringify(result)).not.toContain("fake-local-server-test-key");
    await expect(access(path.join(env.MONEY_COACH_EVALUATION_DIRECTORY!,"session.lock"))).rejects.toThrow();
  }));

  it("allows Next's internal loopback hostname normalization while preserving exact browser Origin and Host",async()=>fixture(async({env})=>{
    const network=vi.fn<typeof fetch>(async()=>response());
    const input=new Request("http://localhost:3001/api/chat",{method:"POST",headers:{host:"127.0.0.1:3001",origin}});
    expect((await createCoachExecutor({env,network})(input,question,"en",10)).source).toBe("model");expect(network).toHaveBeenCalledTimes(1);
  }));

  it("closed/expired/wrong-origin/wrong-revision grants fail closed without resetting receipts",async()=>fixture(async({env,file,read})=>{
    const network=vi.fn<typeof fetch>(async()=>response()),initial=await read();
    for(const changed of [{halted:"evaluation_complete"},{interactiveOrigin:"http://127.0.0.1:3002"},{interactiveRevision:"older-build"},{expiresAt:new Date(Date.now()-100).toISOString()}]) {
      await writeFile(file,JSON.stringify({...initial,...changed}));
      expect((await createCoachExecutor({env,network})(request(),question,"en",10)).source).toBe("rule");
      expect((await read()).attempts).toEqual([]);
    }
    expect(network).not.toHaveBeenCalled();
  }));

  it("concurrent requests share one lock and cannot both consume the model allowance",async()=>fixture(async({env,read})=>{
    let entered!:()=>void,release!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const network=vi.fn<typeof fetch>(async()=>{entered();await gate;return response();});
    const execute=createCoachExecutor({env,network}),first=execute(request(),question,"en",10);
    await started;expect((await execute(request(),question,"en",10)).source).toBe("rule");release();
    expect((await first).source).toBe("model");expect(network).toHaveBeenCalledTimes(1);expect((await read()).attempts).toHaveLength(1);
  }));

  it("failed transport retains unknown usage, halts further traffic and uses a safe local response",async()=>fixture(async({env,read})=>{
    const network=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({error:{message:"Local simulated provider failure",type:"invalid_request_error"}}),{status:429,headers:{"content-type":"application/json"}}));
    const execute=createCoachExecutor({env,network});
    expect((await execute(request(),question,"en",10)).source).toBe("rule");
    expect((await read()).attempts).toMatchObject([{status:"unknown",countedTokens:REQUEST_RESERVATION}]);
    expect((await read()).halted).toBeTruthy();await execute(request(),question,"en",10);expect(network).toHaveBeenCalledTimes(1);
  }));

  it("scope mismatch retains the completed receipt and stops further model calls",async()=>fixture(async({env,read})=>{
    const network=vi.fn<typeof fetch>(async()=>response("dining")),execute=createCoachExecutor({env,network});
    const result=await execute(request(),question,"en",10);
    expect(result.source).toBe("rule");expect(result.message.parts[0]).toMatchObject({text:expect.stringContaining("40,00")});
    expect((await read()).attempts).toMatchObject([{status:"completed",countedTokens:125}]);expect((await read()).halted).toBe("interactive_evaluation_failed");
    await execute(request(),question,"en",10);expect(network).toHaveBeenCalledTimes(1);
  }));

  it("client cancellation preserves the reservation and never publishes a financial fallback",async()=>fixture(async({env,read})=>{
    let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
    const network=vi.fn<typeof fetch>(async(_url,init)=>{entered();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true}));});
    const controller=new AbortController(),pending=createCoachExecutor({env,network})(request(controller.signal),question,"en",10);
    const rejected=expect(pending).rejects.toBeInstanceOf(CoachCancelledError);
    await started;controller.abort();await rejected;
    expect((await read()).attempts).toMatchObject([{status:"unknown",countedTokens:REQUEST_RESERVATION}]);expect((await read()).halted).toBeTruthy();
    expect(network).toHaveBeenCalledTimes(1);
  }));

  it("failed halt persistence retains the lock marker so the next request cannot spend again",async()=>fixture(async({env,read})=>{
    const open:typeof openBudget=async options=>{
      const budget=await openBudget(options);
      return {...budget,halt:async()=>{throw new Error("Local injected persistence failure");}};
    };
    const network=vi.fn<typeof fetch>(async()=>response("dining"));
    expect((await createCoachExecutor({env,open,network})(request(),question,"en",10)).source).toBe("rule");
    expect((await read()).attempts).toMatchObject([{status:"completed",countedTokens:125}]);
    await expect(access(path.join(env.MONEY_COACH_EVALUATION_DIRECTORY!,"session.lock"))).resolves.toBeUndefined();
    expect((await createCoachExecutor({env,network})(request(),question,"en",10)).source).toBe("rule");expect(network).toHaveBeenCalledTimes(1);
  }));
});
