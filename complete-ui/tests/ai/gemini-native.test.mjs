import {test} from "node:test";
import assert from "node:assert/strict";
import {createGeminiNativeTransport} from "../../scripts/gemini-native.mjs";

const input={method:"POST",headers:{authorization:"Bearer fake-key"},body:JSON.stringify({messages:[{role:"system",content:"choose a tool"},{role:"user",content:"question"}],tools:[{type:"function",function:{name:"showTransactions",parameters:{type:"object",properties:{category:{type:"string"}}}}}],max_tokens:2048})};
const reply=call=>({candidates:[{content:{parts:call ? [{functionCall:call}] : [{text:"no tool"}]},finishReason:"STOP"}],usageMetadata:{promptTokenCount:10,totalTokenCount:15}});

test("direct adapter preserves the model's selected function and arguments and makes one request",async()=>{
  let count=0;const adapter=createGeminiNativeTransport(async(url,init)=>{
    count++;assert.equal(String(url),"https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent");
    const body=JSON.parse(init.body);assert.equal(body.toolConfig.functionCallingConfig.mode,"ANY");assert.equal(body.tools[0].functionDeclarations[0].name,"showTransactions");
    assert.equal(body.generationConfig.maxOutputTokens,2048);assert.equal(body.generationConfig.thinkingConfig.thinkingLevel,"MINIMAL");
    return Response.json(reply({name:"showTransactions",args:{category:"taxi"}}));
  });
  const data=await (await adapter("unused",input)).json();
  assert.equal(count,1);assert.equal(data.choices[0].message.tool_calls[0].function.name,"showTransactions");
  assert.deepEqual(JSON.parse(data.choices[0].message.tool_calls[0].function.arguments),{category:"taxi"});
});

test("safe usage diagnostics survive a MAX_TOKENS finish and never expose raw provider fields",async()=>{
  const adapter=createGeminiNativeTransport(async()=>Response.json({candidates:[{finishReason:"MAX_TOKENS"}],usageMetadata:{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:2000,totalTokenCount:2120,secret:"do not expose"}}));
  await assert.rejects(adapter("unused",input),{code:"native_finish_MAX_TOKENS"});
  assert.deepEqual(adapter.diagnostics(),{promptTokenCount:100,candidatesTokenCount:20,thoughtsTokenCount:2000,totalTokenCount:2120,finishReason:"MAX_TOKENS"});
});

test("direct adapter refuses absent calls, malformed output, invalid arguments and incomplete generation",async()=>{
  for(const [response,code] of [[reply(null),"native_tool_missing"],[{},"native_response_invalid"],[reply({name:"showTransactions",args:"bad"}),"native_arguments_invalid"],[{candidates:[{finishReason:"MAX_TOKENS"}]},"native_finish_MAX_TOKENS"]]) {
    const adapter=createGeminiNativeTransport(async()=>Response.json(response));
    await assert.rejects(adapter("unused",input),{code});
  }
});
