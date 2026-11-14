import {MODEL,MAX_OUTPUT_TOKENS} from "./live-budget.mjs";

const rejected=()=>Object.assign(new Error("Model transport boundary rejected"),{code:"transport_boundary_rejected"});
export const GEMINI_MODEL="gemini-3.5-flash";
export const GEMINI_MAX_OUTPUT_TOKENS=2048;
const safeCodes=new Set(["INVALID_ARGUMENT","FAILED_PRECONDITION","PERMISSION_DENIED","UNAUTHENTICATED","NOT_FOUND","RESOURCE_EXHAUSTED","INTERNAL","UNAVAILABLE","DEADLINE_EXCEEDED","invalid_request_error","authentication_error","permission_error","rate_limit_error","server_error"]);
// Provider responses vary between Google objects and OpenAI-compatible arrays.
// Inspect strings only to recognize predefined labels; never return their text.
export function safeGeminiError(data) {
  const values=[];const visit=(value,depth)=>{
    if(depth>6 || values.length>=200) return;
    if(typeof value==="string") values.push(value);
    else if(Array.isArray(value)) for(const item of value.slice(0,30)) visit(item,depth+1);
    else if(value && typeof value==="object") for(const item of Object.values(value).slice(0,30)) visit(item,depth+1);
  };visit(data,0);
  const code=values.find(value=>safeCodes.has(value))??null;
  const text=values.join(" ").toLowerCase();
  const fields=["service_tier","tool_choice","stream_options","parallel_tool_calls","max_tokens","store","tools","model","messages"];
  const field=fields.find(value=>new RegExp(`(?:^|[^a-z0-9_])${value}(?:$|[^a-z0-9_])`).test(text))??null;
  const hint=/schema|parameters|additionalproperties/.test(text) ? "tool_schema" : /streaming/.test(text) ? "streaming" : /model.*(?:not found|not supported|unavailable)/.test(text) ? "model_unavailable" : null;
  return {code,hint,field};
}

/** One transport per model turn; its budget must already hold the session lock. */
export function createGuardedTransport({budget,network=globalThis.fetch,provider="openai",nonStreaming=false}) {
  if(!["openai","gemini"].includes(provider)) throw rejected();
  if(nonStreaming && provider!=="gemini") throw rejected();
  const endpoint=provider==="gemini" ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions" : "https://api.openai.com/v1/chat/completions";
  const model=provider==="gemini" ? GEMINI_MODEL : MODEL;
  let claimed=false,pending=false,settled=false,reservation=null,fetches=0,httpStatus=null,failure=null,providerCode=null,providerHint=null,providerField=null;
  const deny=()=>{failure="transport_rejected";throw rejected();};
  return {
    async fetch(url,init) {
      // Claim synchronously, before awaiting durable accounting, to exclude races.
      if(claimed || settled) deny();
      claimed=true;
      if(String(url)!==endpoint || init?.method!=="POST" ||
        init.signal?.aborted || typeof init.body!=="string" || Buffer.byteLength(init.body)>65536) deny();
      let body;try {body=JSON.parse(init.body);} catch {deny();}
      if(!body || body.model!==model || body.max_tokens!==(provider==="gemini" && nonStreaming ? GEMINI_MAX_OUTPUT_TOKENS : MAX_OUTPUT_TOKENS) || (nonStreaming ? body.stream!==undefined && body.stream!==false : body.stream!==true) ||
        body.store!==false || body.parallel_tool_calls!==false || body.service_tier!=="default" ||
        body.n!==undefined || body.tool_choice!=="required" || (nonStreaming ? body.stream_options!==undefined : body.stream_options?.include_usage!==true) ||
        !Array.isArray(body.tools) || body.tools.some(tool=>tool?.type!=="function")) deny();
      pending=true;
      try {
        reservation=await budget.reserve();
        if(typeof reservation!=="string" || !reservation) throw rejected();
        fetches++;
        // Gemini's OpenAI compatibility endpoint rejects the OpenAI-only
        // `store` field. Validate its false value above, then omit that field
        // from the synthetic-data Gemini request; never alter OpenAI traffic.
        const outgoing=provider==="gemini" ? (()=>{const copy={...body};delete copy.store;return JSON.stringify(copy);})() : init.body;
        let response;try {response=await network(url,{...init,body:outgoing,redirect:"error"});} catch(error) {const code=error?.code;
          failure=typeof code==="string" && /^native_(?:request_invalid|response_invalid|tool_missing|tool_count|tool_invalid|arguments_invalid|usage_invalid|finish_(?:STOP|MAX_TOKENS|SAFETY|RECITATION|OTHER|BLOCKLIST|PROHIBITED_CONTENT|SPII|MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|UNKNOWN))$/.test(code) ? code : "network_error";throw error;}
        httpStatus=response.status;
        if(provider==="gemini" && !response.ok) {
          failure="provider_http";
          // Extract only known status identifiers. Never log provider messages,
          // response bodies, request contents, headers or credentials.
          try {const safe=safeGeminiError(await response.clone().json());
            providerCode=safe.code;providerHint=safe.hint;providerField=safe.field;
          } catch {}
        }
        if(provider==="gemini" && !nonStreaming && response.ok && response.body) {
          const reader=response.body.getReader();
          const stream=new ReadableStream({
            async pull(controller) {try {const part=await reader.read();if(part.done) controller.close();else controller.enqueue(part.value);} catch(error) {failure="provider_stream";controller.error(error);}},
            cancel(reason) {return reader.cancel(reason);},
          });
          return new Response(stream,{status:response.status,statusText:response.statusText,headers:response.headers});
        }
        return response;
      } finally {pending=false;}
    },
    async settle(usage,reason) {
      if(settled || pending) throw rejected();
      settled=true;
      if(reservation) await budget.settle(reservation,usage,reason);
    },
    snapshot:()=>({fetches,httpStatus,reserved:reservation!==null,settled,...(provider==="gemini" ? {failure,providerCode,providerHint,providerField} : {})}),
  };
}
