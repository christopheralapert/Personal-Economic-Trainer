import {test} from "node:test";
import assert from "node:assert/strict";
import {createOpenAI} from "@ai-sdk/openai";
import {streamText,stepCountIs,tool} from "ai";
import {z} from "zod";
import {createGuardedTransport,GEMINI_MODEL,safeGeminiError} from "../../scripts/guarded-transport.mjs";
import {MODEL} from "../../scripts/live-budget.mjs";

const endpoint="https://api.openai.com/v1/chat/completions";
const body={model:MODEL,max_tokens:512,stream:true,store:false,parallel_tool_calls:false,service_tier:"default",tool_choice:"required",stream_options:{include_usage:true},tools:[{type:"function"}]};
const request=changed=>({method:"POST",body:JSON.stringify({...body,...changed})});

test("invalid endpoint, cost/receipt controls and aborted requests never reach accounting or network",async()=>{
  let reservations=0,fetches=0;
  const budget={reserve:async()=>{reservations++;return "id";}};
  const controller=new AbortController();controller.abort();
  for(const [url,init] of [
    ["https://example.com",request()],[endpoint+"?redirect=1",request()],
    [endpoint,{...request(),method:"GET"}],[endpoint,{...request(),body:"{"}],
    [endpoint,request({model:"other-model"})],[endpoint,request({max_tokens:513})],
    [endpoint,request({store:true})],[endpoint,request({parallel_tool_calls:true})],
    [endpoint,request({stream:false})],[endpoint,request({service_tier:"priority"})],
    [endpoint,request({n:2})],[endpoint,request({stream_options:{}})],
    [endpoint,request({tool_choice:"none"})],[endpoint,request({tools:[{type:"web_search"}]})],
    [endpoint,request({tools:[null]})],[endpoint,request({messages:[{content:"ä".repeat(40000)}]})],
    [endpoint,{...request(),signal:controller.signal}],
  ]) {
    const guarded=createGuardedTransport({budget,network:async()=>{fetches++;return new Response();}});
    await assert.rejects(guarded.fetch(url,init),{code:"transport_boundary_rejected"});
    await assert.rejects(guarded.fetch(endpoint,request()),{code:"transport_boundary_rejected"});
  }
  assert.equal(reservations,0);assert.equal(fetches,0);
});

test("network waits for durable reservation, concurrent/repeated calls are excluded and errors are never retried",async()=>{
  let release,networkCalls=0;
  const written=new Promise(resolve=>{release=resolve;});
  const receipts=[];
  const guarded=createGuardedTransport({budget:{reserve:()=>written,settle:async(...args)=>{receipts.push(args);}},network:async(url,init)=>{
    networkCalls++;assert.equal(url,endpoint);assert.equal(init.redirect,"error");return new Response();
  }});
  const pending=guarded.fetch(endpoint,request());
  assert.equal(networkCalls,0);
  await assert.rejects(guarded.settle(null,"premature"),{code:"transport_boundary_rejected"});
  await assert.rejects(guarded.fetch(endpoint,request()),{code:"transport_boundary_rejected"});
  release("durable-id");await pending;
  await guarded.settle({inputTokens:100,outputTokens:25,totalTokens:125},"model_tool");
  assert.equal(networkCalls,1);assert.deepEqual(receipts,[["durable-id",{inputTokens:100,outputTokens:25,totalTokens:125},"model_tool"]]);
  await assert.rejects(guarded.settle(null,"again"),{code:"transport_boundary_rejected"});
  const failed=createGuardedTransport({budget:{reserve:async()=>"failure-id",settle:async(...args)=>{receipts.push(args);}},network:async()=>{networkCalls++;throw new Error("Local simulated network failure");}});
  await assert.rejects(failed.fetch(endpoint,request()));await failed.settle(null,"interrupted");
  assert.equal(networkCalls,2);assert.deepEqual(receipts.at(-1),["failure-id",null,"interrupted"]);
  await assert.rejects(failed.fetch(endpoint,request()),{code:"transport_boundary_rejected"});
});

test("actual OpenAI SDK request and streaming usage pass the shared guard with a fake key and local transport",async()=>{
  const receipts=[];let reservations=0;
  const guarded=createGuardedTransport({budget:{reserve:async()=>{reservations++;return "sdk-id";},settle:async(...args)=>{receipts.push(args);}},network:async()=>{
    const chunk=(delta,finish_reason)=>({id:"local-sdk",object:"chat.completion.chunk",created:0,model:MODEL,choices:[{index:0,delta,finish_reason}]});
    const frames=[chunk({role:"assistant",tool_calls:[{index:0,id:"call",type:"function",function:{name:"showSafeToSpend",arguments:"{}"}}]},null),{...chunk({},"tool_calls"),usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}}];
    return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
  }});
  const model=createOpenAI({apiKey:"fake-local-guard-test-key",fetch:guarded.fetch}).chat(MODEL);
  const result=streamText({model,prompt:"Review spending room",tools:{showSafeToSpend:tool({inputSchema:z.object({}),execute:async()=>({amount:null})})},
    toolChoice:"required",stopWhen:stepCountIs(1),maxOutputTokens:512,maxRetries:0,providerOptions:{openai:{store:false,parallelToolCalls:false,serviceTier:"default"}},onError:()=>{}});
  const outputs=await result.toolResults,usage=await result.totalUsage;
  assert.equal(outputs.length,1);assert.deepEqual(outputs[0].output,{amount:null});
  await guarded.settle({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.inputTokens+usage.outputTokens},"model_tool");
  assert.equal(reservations,1);assert.deepEqual(guarded.snapshot(),{fetches:1,httpStatus:200,reserved:true,settled:true});
  assert.deepEqual(receipts,[["sdk-id",{inputTokens:100,outputTokens:25,totalTokens:125},"model_tool"]]);
});

test("Gemini-compatible SDK tool streaming uses only the exact provider endpoint and records usage with a mock transport",async()=>{
  const receipts=[];let calls=0;
  const guarded=createGuardedTransport({provider:"gemini",budget:{reserve:async()=>"mock-id",settle:async(...args)=>receipts.push(args)},network:async(url,init)=>{
    calls++;assert.equal(String(url),"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions");
    assert.equal(Object.hasOwn(JSON.parse(init.body),"store"),false);
    const chunk=(delta,finish_reason)=>({id:"mock",object:"chat.completion.chunk",created:0,model:GEMINI_MODEL,choices:[{index:0,delta,finish_reason}]});
    const frames=[chunk({role:"assistant",tool_calls:[{index:0,id:"call",type:"function",function:{name:"showSafeToSpend",arguments:"{}"}}]},null),{...chunk({},"tool_calls"),usage:{prompt_tokens:100,completion_tokens:25,total_tokens:125}}];
    return new Response(frames.map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}});
  }});
  const model=createOpenAI({apiKey:"fake-test-key",baseURL:"https://generativelanguage.googleapis.com/v1beta/openai",fetch:guarded.fetch}).chat(GEMINI_MODEL);
  const result=streamText({model,prompt:"Review spending room",tools:{showSafeToSpend:tool({inputSchema:z.object({}),execute:async()=>({amount:null})})},toolChoice:"required",stopWhen:stepCountIs(1),maxOutputTokens:512,maxRetries:0,providerOptions:{openai:{store:false,parallelToolCalls:false,serviceTier:"default"}},onError:()=>{}});
  expectTool(await result.toolResults);const usage=await result.totalUsage;
  await guarded.settle({inputTokens:usage.inputTokens,outputTokens:usage.outputTokens,totalTokens:usage.inputTokens+usage.outputTokens},"model_tool");
  assert.equal(calls,1);assert.deepEqual(receipts,[["mock-id",{inputTokens:100,outputTokens:25,totalTokens:125},"model_tool"]]);
});
function expectTool(outputs){assert.equal(outputs.length,1);assert.deepEqual(outputs[0].output,{amount:null});}

test("Gemini error objects and arrays reveal only known codes and fields",()=>{
  for(const data of [{error:{status:"INVALID_ARGUMENT",message:"Bad service_tier SECRET_VALUE"}},[{error:{status:"INVALID_ARGUMENT",message:"Bad service_tier SECRET_VALUE"}}]]) {
    const safe=safeGeminiError(data);
    assert.deepEqual(safe,{code:"INVALID_ARGUMENT",hint:null,field:"service_tier"});
    assert.ok(!JSON.stringify(safe).includes("SECRET_VALUE"));
  }
});

test("Gemini stream interruptions are distinguishable without exposing provider error text",async()=>{
  const guarded=createGuardedTransport({provider:"gemini",budget:{reserve:async()=>"id",settle:async()=>{}},network:async()=>new Response(new ReadableStream({pull(controller){controller.error(new Error("private provider text"));}}))});
  const response=await guarded.fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",request({model:GEMINI_MODEL}));
  await assert.rejects(response.text());
  assert.equal(guarded.snapshot().failure,"provider_stream");
  assert.ok(!JSON.stringify(guarded.snapshot()).includes("private provider text"));
});
