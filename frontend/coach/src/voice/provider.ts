import "server-only";
import {z} from "zod";

export const VOICE_ENDPOINT="https://generativelanguage.googleapis.com/v1beta/interactions";
export const TRANSCRIBE_MODEL="gemini-3.5-transcribe",SPEECH_MODEL="gemini-3.8-flash-tts";
export const languageCodes={en:"en-US",fi:"fi-FI",et:"et-EE"} as const;
export class VoiceError extends Error {constructor(readonly code:string,readonly status=502,readonly retryAfter?:string){super(code);}}
const content=z.discriminatedUnion("type",[z.object({type:z.literal("text"),text:z.string().max(2000)}),z.object({type:z.literal("audio"),mime_type:z.literal("audio/wav"),data:z.string().max(3000000)})]);
const resultSchema=z.object({status:z.literal("completed"),steps:z.array(z.object({type:z.string(),content:z.array(content).optional()})).max(10),usage:z.object({total_input_tokens:z.number().int().nonnegative(),total_output_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().positive()})});
export type VoiceUsage=z.infer<typeof resultSchema>["usage"];
export function createVoiceProvider(key:string,network:typeof fetch=globalThis.fetch){
 async function call(body:unknown,signal:AbortSignal){
  const timer=AbortSignal.timeout(30000);
  let response:Response;try {response=await network(VOICE_ENDPOINT,{method:"POST",headers:{"content-type":"application/json","x-goog-api-key":key,"Api-Revision":"2026-05-20"},body:JSON.stringify(body),redirect:"error",signal:AbortSignal.any([signal,timer])});}
  catch {throw new VoiceError(signal.aborted ? "cancelled" : timer.aborted ? "timeout" : "provider_unavailable",signal.aborted ? 499 : 502);}
  if(!response.ok){void response.body?.cancel().catch(()=>{});const wait=response.headers.get("retry-after");throw new VoiceError(response.status===429 ? "provider_wait" : "provider_rejected",response.status===429 ? 429 : 502,wait && /^\d{1,5}$/.test(wait) ? wait : undefined);}
  // Bound before JSON parsing; provider errors/body content never enter logs.
  const reader=response.body?.getReader();if(!reader)throw new VoiceError("provider_shape");
  const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4000000){void reader.cancel().catch(()=>{});throw new VoiceError("provider_size");}chunks.push(part.value);}}
  finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  let parsed:z.infer<typeof resultSchema>;try{parsed=resultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));}catch{throw new VoiceError("provider_shape");}
  const parts=parsed.steps.filter(step=>step.type==="model_output").flatMap(step=>step.content??[]);
  return {parts,usage:parsed.usage};
 }
 return {
  async transcribe(audio:Uint8Array,mime:string,locale:keyof typeof languageCodes,signal:AbortSignal){
   const result=await call({model:TRANSCRIBE_MODEL,input:[{type:"audio",mime_type:mime,data:Buffer.from(audio).toString("base64")}],generation_config:{transcription_config:{language_codes:[languageCodes[locale]]}}},signal);
   const text=result.parts.filter(part=>part.type==="text").map(part=>part.text).join(" ").trim();
   if(!text || text.length>2000)throw new VoiceError("transcript_empty");return {text,usage:result.usage};
  },
  async speak(text:string,signal:AbortSignal){
   const result=await call({model:SPEECH_MODEL,input:[{type:"user_input",content:[{type:"text",text}]}],response_format:{type:"audio"},generation_config:{speech_config:[{voice:"Kore"}]}},signal);
   const parts=result.parts.filter(part=>part.type==="audio");if(parts.length!==1)throw new VoiceError("audio_missing");
   const encoded=parts[0].data;if(!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length%4!==0)throw new VoiceError("audio_invalid");
   const audio=Buffer.from(encoded,"base64");if(audio.length<44 || audio.toString("ascii",0,4)!=="RIFF" || audio.toString("ascii",8,12)!=="WAVE")throw new VoiceError("audio_invalid");
   return {audio,usage:result.usage};
  },
 };
}
