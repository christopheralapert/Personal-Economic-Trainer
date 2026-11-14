import "server-only";
import path from "node:path";
import {z} from "zod";
import {COACH_REVISION,REVISION_HEADER} from "@/coach/transport";
import {readCoachJSON,CoachRequestError} from "@/coach/request";
import {createComponentTools,type ToolName} from "@/coach/catalog";
import {spokenAnswer} from "@/coach/spoken-answer";
import {loadDataset,datasetKeySchema} from "@/engine/datasets";
import {dataScopeSchema,scopedDataset} from "@/engine/data-scope";
import {createVoiceProvider,VoiceError,SPEECH_MODEL,TRANSCRIBE_MODEL} from "./provider";
import {withVoiceReservation} from "./budget";

export const MAX_VOICE_BYTES=524288,MAX_RECORDING_MS=20000;
const localeSchema=z.enum(["en","fi","et"]);
const speechSchema=z.object({dataset:datasetKeySchema.refine(key=>key.startsWith("organizer")),locale:localeSchema,savingsPercent:z.number().int().min(0).max(100),scope:dataScopeSchema.optional(),tool:z.string().min(1).max(40),input:z.record(z.string(),z.unknown())}).strict();
async function audioBytes(request:Request){
 const length=request.headers.get("content-length");if(length!==null && (!/^\d+$/.test(length) || BigInt(length)>BigInt(MAX_VOICE_BYTES)))throw new VoiceError("audio_size",413);
 if(request.headers.get("content-encoding") && request.headers.get("content-encoding")!=="identity")throw new VoiceError("audio_type",415);
 const reader=request.body?.getReader();if(!reader)throw new VoiceError("audio_empty",400);
 let timer:ReturnType<typeof setTimeout>|undefined;const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new VoiceError("upload_timeout",408)),5000);});
 const chunks:Uint8Array[]=[];let size=0;
 try{while(true){if(request.signal.aborted)throw new VoiceError("cancelled",499);const part=await Promise.race([reader.read(),deadline]);if(part.done)break;size+=part.value.length;if(size>MAX_VOICE_BYTES)throw new VoiceError("audio_size",413);chunks.push(part.value);}if(size===0)throw new VoiceError("audio_empty",400);}
 catch(error){void reader.cancel().catch(()=>{});throw error;}finally{clearTimeout(timer);reader.releaseLock();}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length;}return result;
}
export function createVoiceRoutes({env=process.env,network=globalThis.fetch}:{env?:Record<string,string|undefined>;network?:typeof fetch}={}) {
 const file=env.MONEY_COACH_VOICE_LEDGER_PATH,maximum=env.MONEY_COACH_VOICE_REQUEST_POLICY==="unmetered" ? null : Number(env.MONEY_COACH_VOICE_MAX_REQUESTS??"20");
 const enabled=()=>env.MONEY_COACH_GEMINI_VOICE_ENABLED==="true" && Boolean(env.GEMINI_API_KEY) && Boolean(file && path.isAbsolute(file)) && (maximum===null || Number.isInteger(maximum) && maximum>=1 && maximum<=100);
 const headers=()=>({"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",[REVISION_HEADER]:COACH_REVISION});
 function guard(request:Request){
  if(request.headers.get("X-Money-Coach-Privacy")!=="off")throw new VoiceError("privacy_required",403);
  if(!COACH_REVISION || request.headers.get(REVISION_HEADER)!==COACH_REVISION)throw new VoiceError("build_changed",409);
  try {const origin=new URL(request.headers.get("origin")??"");if(!["http:","https:"].includes(origin.protocol) || origin.host!==request.headers.get("host"))throw new Error();}catch{throw new VoiceError("origin_rejected",403);}
  if(!enabled())throw new VoiceError("voice_disabled",503);
 }
 function failed(error:unknown){const e=error instanceof VoiceError ? error : error instanceof CoachRequestError ? new VoiceError("invalid_request",error.status) : new VoiceError("invalid_request",400);return Response.json({error:e.code},{status:e.status,headers:{...headers(),...(e.retryAfter ? {"Retry-After":e.retryAfter} : {})}});}
 return {
  capabilities:async()=>Response.json({enabled:enabled(),provider:"gemini",transcriptionModel:TRANSCRIBE_MODEL,speechModel:SPEECH_MODEL,maxRecordingMs:MAX_RECORDING_MS},{headers:headers()}),
  transcribe:async(request:Request)=>{try{
   guard(request);const locale=localeSchema.parse(request.headers.get("X-Money-Coach-Language"));
   const mime=(request.headers.get("content-type")??"").split(";")[0].toLowerCase();
   if(!["audio/webm","audio/ogg","audio/mp4","audio/wav"].includes(mime))throw new VoiceError("audio_type",415);
   const audio=await audioBytes(request);if(request.signal.aborted)throw new VoiceError("cancelled",499);
   const provider=createVoiceProvider(env.GEMINI_API_KEY!,network);
   const result=await withVoiceReservation(file!,maximum,"transcribe",()=>provider.transcribe(audio,mime==="audio/mp4" ? "audio/m4a" : mime,locale,request.signal));
   return Response.json({text:result.text,provider:"gemini"},{headers:headers()});
  }catch(error){return failed(error);}},
  speak:async(request:Request)=>{try{
   guard(request);const body=speechSchema.parse(await readCoachJSON(request)),data=scopedDataset(await loadDataset(body.dataset),body.scope),tools=createComponentTools(body.savingsPercent,data);
   if(!Object.hasOwn(tools,body.tool))throw new VoiceError("tool_invalid",400);
   const name=body.tool as ToolName,tool=tools[name],input=(tool.inputSchema as z.ZodType<Record<string,unknown>>).parse(body.input);
   const output=await (tool.execute as (input:unknown,options:unknown)=>Promise<unknown>)(input,{toolCallId:"voice",messages:[]});
   const text=spokenAnswer(name,input as Record<string,unknown>,output,body.locale);if(!text || text.length>600)throw new VoiceError("speech_unavailable",400);
   if(request.signal.aborted)throw new VoiceError("cancelled",499);
   const provider=createVoiceProvider(env.GEMINI_API_KEY!,network),result=await withVoiceReservation(file!,maximum,"speak",()=>provider.speak(text,request.signal));
   return new Response(new Uint8Array(result.audio),{headers:{...headers(),"Content-Type":"audio/wav","X-Money-Coach-Voice-Provider":"gemini"}});
  }catch(error){return failed(error);}},
 };
}
