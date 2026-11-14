import {it,expect,vi} from 'vitest';
import {streamSpeech} from './stream-provider';
const usage={total_input_tokens:10,total_output_tokens:20,total_tokens:30};
const events=[{event_type:'step.start',index:0,step:{type:'model_output'}},{event_type:'step.delta',index:0,delta:{type:'audio',mime_type:'audio/l16',data:Buffer.alloc(4800).toString('base64')}},{event_type:'interaction.completed',interaction:{status:'completed',usage}}];
it('delivers PCM before completion and accounts only completed usage',async()=>{
 let release!:()=>void;const gate=new Promise<void>(r=>release=r),encoder=new TextEncoder();
 const network=vi.fn<typeof fetch>(async()=>new Response(new ReadableStream({async start(c){for(const event of events.slice(0,2))c.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));await gate;c.enqueue(encoder.encode(`data: ${JSON.stringify(events[2])}\n\ndata: [DONE]\n\n`));c.close();}})));
 const audio=vi.fn(),pending=streamSpeech('test-key','Synthetic answer',new AbortController().signal,audio,network);await vi.waitFor(()=>expect(audio).toHaveBeenCalledTimes(1));release();expect(await pending).toEqual({usage});expect(JSON.parse(network.mock.calls[0][1]!.body as string)).toMatchObject({stream:true,response_format:{mime_type:'audio/l16',sample_rate:24000}});
});
it('rejects malformed or unfinished audio and respects cancellation',async()=>{
 const network=vi.fn<typeof fetch>(async()=>new Response(events.slice(0,2).map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')));await expect(streamSpeech('test','Synthetic',new AbortController().signal,()=>{},network)).rejects.toThrow('audio_missing');
 const controller=new AbortController();controller.abort();const cancelled=vi.fn<typeof fetch>(async(_url,init)=>{expect(init!.signal!.aborted).toBe(true);throw new Error('abort');});await expect(streamSpeech('test','Synthetic',controller.signal,()=>{},cancelled)).rejects.toThrow();
});
