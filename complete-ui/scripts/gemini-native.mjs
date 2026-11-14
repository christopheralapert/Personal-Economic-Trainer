// Adapts the SDK's local, validated tool request to Google's generateContent
// API. Only the model's function selection is returned to the SDK; tool
// execution and financial calculations remain inside Money Coach.
const failed=code=>Object.assign(new Error("Gemini response unavailable"),{code});
const finishCodes=new Set(["STOP","MAX_TOKENS","SAFETY","RECITATION","OTHER","BLOCKLIST","PROHIBITED_CONTENT","SPII","MALFORMED_FUNCTION_CALL","UNEXPECTED_TOOL_CALL"]);
export function createGeminiNativeTransport(network=globalThis.fetch) {
  let diagnostics=null;
  const fetcher=async(_url,init)=>{
    const body=JSON.parse(init.body),headers=new Headers(init.headers),authorization=headers.get("authorization")??"";
    if(!authorization.startsWith("Bearer ") || !Array.isArray(body.messages) || !Array.isArray(body.tools)) throw failed("native_request_invalid");
    const system=[],contents=[];
    for(const message of body.messages) {
      if(typeof message.content!=="string" || !["system","user"].includes(message.role)) throw failed("native_request_invalid");
      if(message.role==="system") system.push({text:message.content});
      else contents.push({role:"user",parts:[{text:message.content}]});
    }
    const declarations=body.tools.map(item=>{
      if(item?.type!=="function" || typeof item.function?.name!=="string" || !item.function?.parameters) throw failed("native_request_invalid");
      return {name:item.function.name,description:item.function.description,parametersJsonSchema:item.function.parameters};
    });
    const request={systemInstruction:{parts:system},contents,tools:[{functionDeclarations:declarations}],toolConfig:{functionCallingConfig:{mode:"ANY"}},generationConfig:{maxOutputTokens:body.max_tokens,thinkingConfig:{thinkingLevel:"MINIMAL"}}};
    const response=await network("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":authorization.slice(7)},body:JSON.stringify(request),signal:init.signal,redirect:"error"});
    if(!response.ok) return response;
    let data;try {data=await response.json();} catch {throw failed("native_response_invalid");}
    if(data?.usageMetadata && typeof data.usageMetadata==="object") {
      diagnostics={};
      for(const field of ["promptTokenCount","candidatesTokenCount","thoughtsTokenCount","totalTokenCount"]) {
        const value=data.usageMetadata[field];if(Number.isSafeInteger(value) && value>=0) diagnostics[field]=value;
      }
      const finish=data?.candidates?.[0]?.finishReason;
      if(finishCodes.has(finish)) diagnostics.finishReason=finish;
    }
    if(!Array.isArray(data?.candidates) || data.candidates.length!==1) throw failed("native_response_invalid");
    const candidate=data.candidates[0],finish=finishCodes.has(candidate?.finishReason) ? candidate.finishReason : "UNKNOWN";
    if(finish!=="STOP") throw failed(`native_finish_${finish}`);
    const parts=candidate?.content?.parts;
    if(!Array.isArray(parts)) throw failed("native_response_invalid");
    const calls=parts.filter(part=>part && typeof part==="object" && Object.hasOwn(part,"functionCall"));
    if(calls.length===0) throw failed("native_tool_missing");
    if(calls.length!==1) throw failed("native_tool_count");
    const call=calls[0].functionCall;
    if(!call || typeof call.name!=="string" || !declarations.some(declaration=>declaration.name===call.name)) throw failed("native_tool_invalid");
    if(!call.args || typeof call.args!=="object" || Array.isArray(call.args)) throw failed("native_arguments_invalid");
    const usage=data.usageMetadata,prompt=usage?.promptTokenCount,total=usage?.totalTokenCount;
    if(!Number.isSafeInteger(prompt) || !Number.isSafeInteger(total) || prompt<0 || total<prompt || total===0) throw failed("native_usage_invalid");
    return Response.json({id:"gemini-native",object:"chat.completion",created:0,model:"gemini-3.5-flash",choices:[{index:0,message:{role:"assistant",content:null,tool_calls:[{id:"gemini-tool",type:"function",function:{name:call.name,arguments:JSON.stringify(call.args)}}]},finish_reason:"tool_calls"}],usage:{prompt_tokens:prompt,completion_tokens:total-prompt,total_tokens:total}});
  };
  fetcher.diagnostics=()=>diagnostics;
  return fetcher;
}
