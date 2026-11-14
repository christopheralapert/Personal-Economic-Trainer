import 'server-only';
import {z} from 'zod';
import {VOICE_ENDPOINT,SPEECH_MODEL,VoiceError,type VoiceUsage} from './provider';
const usageSchema=z.object({total_input_tokens:z.number().int().nonnegative(),total_output_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().positive()});
/** Gemini Interactions step.delta audio is 24 kHz mono signed little-endian PCM. */
export async function streamSpeech(key:string,text:string,signal:AbortSignal,onAudio:(data:string,providerMs:number)=>void,network:typeof fetch=globalThis.fetch):Promise<{usage:VoiceUsage}>{
 const start=performance.now(),bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
 const response=await network(VOICE_ENDPOINT,{method:'POST',headers:{'content-type':'application/json','x-goog-api-key':key,'Api-Revision':'2026-05-20'},redirect:'error',signal:bounded,body:JSON.stringify({model:SPEECH_MODEL,input:[{type:'user_input',content:[{type:'text',text}]}],response_format:{type:'audio',mime_type:'audio/l16',sample_rate:24000},generation_config:{speech_config:[{voice:'Kore'}]},stream:true})});
 if(!response.ok){void response.body?.cancel();throw new VoiceError(response.status===429?'provider_wait':'provider_rejected');}
 const reader=response.body?.getReader();if(!reader)throw new VoiceError('provider_shape');
 const decoder=new TextDecoder();let buffer='',size=0,chunks=0,usage:VoiceUsage|null=null;const outputs=new Set<number>();
 function event(block:string){
  const raw=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');if(!raw || raw==='[DONE]')return;
  const value=JSON.parse(raw);
  if(value.event_type==='error')throw new VoiceError('provider_failed');
  if(value.event_type==='step.start'&&value.step?.type==='model_output')outputs.add(value.index);
  if(value.event_type==='step.delta'&&value.delta?.type==='audio'){
   const delta=value.delta;if(!outputs.has(value.index)||delta.mime_type!=='audio/l16'||typeof delta.data!=='string'||delta.data.length>3000000||!/^[A-Za-z0-9+/]+={0,2}$/u.test(delta.data)||delta.data.length%4!==0)throw new VoiceError('audio_invalid');
   if((delta.sample_rate!==undefined&&delta.sample_rate!==24000)||(delta.channels!==undefined&&delta.channels!==1))throw new VoiceError('audio_invalid');
   const bytes=Buffer.from(delta.data,'base64');if(!bytes.length||bytes.length%2!==0)throw new VoiceError('audio_invalid');chunks++;onAudio(delta.data,performance.now()-start);
  }
  if(value.event_type==='interaction.completed')usage=usageSchema.parse(value.interaction?.usage);
 }
 try{while(true){if(bounded.aborted)throw new VoiceError('cancelled');const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>4000000)throw new VoiceError('provider_size');buffer+=decoder.decode(item.value,{stream:true}).replaceAll('\r','');let end;while((end=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,end));buffer=buffer.slice(end+2);}}if(buffer.trim())event(buffer);if(!usage||!chunks)throw new VoiceError('audio_missing');return {usage};}
 finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
}
