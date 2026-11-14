export const pcmContentType='application/x-money-coach-pcm';
/** Schedule bounded PCM chunks immediately; only a completed stream becomes replayable. */
export async function playPCM(response:Response,context:AudioContext,signal:AbortSignal,onFirst:(providerMs:number)=>void,onEnd:()=>void):Promise<Blob>{
 const reader=response.body?.getReader();if(!reader)throw Error('audio_missing');
 const chunks:Uint8Array[]=[];const decoder=new TextDecoder();let pending='',bytes=0,next=context.currentTime,first=true,done=false,playbackReady=false,lastEnded=false,last:AudioBufferSourceNode|undefined;
 const abort=()=>{void reader.cancel().catch(()=>{});void context.close().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 function line(text:string){
  const value=JSON.parse(text);if(value.type==='error')throw Error('speech_failed');if(value.type==='done'){done=true;return;}
  if(value.type!=='audio'||typeof value.data!=='string'||value.data.length>3000000||signal.aborted)throw Error('audio_invalid');
  const binary=atob(value.data),chunk=Uint8Array.from(binary,c=>c.charCodeAt(0));bytes+=chunk.length;if(bytes>3000000||chunk.length%2)throw Error('audio_size');chunks.push(chunk);
  const buffer=context.createBuffer(1,chunk.length/2,24000),samples=buffer.getChannelData(0),view=new DataView(chunk.buffer);for(let i=0;i<samples.length;i++)samples[i]=view.getInt16(i*2,true)/32768;
  const node=context.createBufferSource();node.buffer=buffer;node.connect(context.destination);next=Math.max(context.currentTime+0.02,next);node.start(next);if(first){first=false;onFirst(value.providerMs);}next+=buffer.duration;last=node;lastEnded=false;node.onended=()=>{if(node===last){lastEnded=true;if(playbackReady&&!signal.aborted)onEnd();}};
 }
 try{await context.resume();while(true){if(signal.aborted)throw Error('cancelled');const item=await reader.read();if(item.done)break;pending+=decoder.decode(item.value,{stream:true});if(pending.length>4000000)throw Error('audio_size');let end;while((end=pending.indexOf('\n'))>=0){const text=pending.slice(0,end);pending=pending.slice(end+1);if(text)line(text);}}if(pending.trim())line(pending);if(!done||!last||!bytes)throw Error('audio_incomplete');playbackReady=true;if(lastEnded)setTimeout(()=>{if(!signal.aborted)onEnd();},0);
  const wav=new Uint8Array(44+bytes),view=new DataView(wav.buffer),put=(offset:number,value:string)=>{for(let i=0;i<value.length;i++)wav[offset+i]=value.charCodeAt(i);};put(0,'RIFF');view.setUint32(4,36+bytes,true);put(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,24000,true);view.setUint32(28,48000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);put(36,'data');view.setUint32(40,bytes,true);let offset=44;for(const chunk of chunks){wav.set(chunk,offset);offset+=chunk.length;}return new Blob([wav],{type:'audio/wav'});
 }catch(error){void context.close().catch(()=>{});throw error;}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
}
