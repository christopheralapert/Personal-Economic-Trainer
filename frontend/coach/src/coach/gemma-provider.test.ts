import {describe,it,expect,vi} from 'vitest';
import {LocalGemmaProvider,gemmaConfig,mentionsRecords,type GemmaConfig} from './gemma-provider';
import {loadDataset} from '@/engine/datasets';
import {CoachCancelledError} from './execution';

const config:GemmaConfig={url:'http://127.0.0.1:11434',model:'gemma3:4b',timeoutMs:5000,replyLanguages:['en']};
const show={details:{format:'gguf',family:'gemma3'},model_info:{'general.architecture':'gemma3'}};
const chat=(content:unknown)=>({model:'gemma3:4b',done:true,done_reason:'stop',message:{role:'assistant',content:JSON.stringify(content)}});
const slots=(value:Record<string,unknown>)=>({kind:'unclear',category:'none',period:'none',month:'none',percent:0,concept:'none',reply:'',...value});
/** Ollama stand-in: /api/show metadata, then queued /api/chat contents in order. */
function ollama(replies:unknown[],info:unknown=show){
 const queue=[...replies];
 return vi.fn<typeof fetch>(async(url)=>{
  const path=new URL(String(url)).pathname;
  if(path==='/api/show')return Response.json(info);
  if(path==='/api/chat'){const next=queue.shift();if(next===undefined)throw new Error('unexpected chat');return Response.json(chat(next));}
  throw new Error('unexpected path '+path);
 });
}
const text=(parts:{type:string}[])=>parts.filter(part=>part.type==='text').map(part=>(part as unknown as {text:string}).text).join(' ');

describe('local Gemma configuration',()=>{
 it('is off unless explicitly enabled and accepts only literal loopback HTTP',()=>{
  expect(gemmaConfig({})).toBeNull();
  expect(gemmaConfig({MONEY_COACH_LOCAL_GEMMA_ENABLED:'true'})).toEqual({url:'http://127.0.0.1:11434',model:'gemma3:4b',timeoutMs:30000,replyLanguages:['en']});
  for(const url of ['https://127.0.0.1:11434','http://10.0.0.5:11434','http://ollama.example:11434','http://127.0.0.1:11434/v1','http://user:pw@127.0.0.1:11434','http://127.0.0.1.nip.io:11434'])
   expect(gemmaConfig({MONEY_COACH_LOCAL_GEMMA_ENABLED:'true',MONEY_COACH_LOCAL_GEMMA_URL:url}),url).toBeNull();
  expect(gemmaConfig({MONEY_COACH_LOCAL_GEMMA_ENABLED:'true',MONEY_COACH_LOCAL_GEMMA_MODEL:'gpt-oss:120b-cloud'})).toBeNull();
  expect(gemmaConfig({MONEY_COACH_LOCAL_GEMMA_ENABLED:'true',MONEY_COACH_LOCAL_GEMMA_REPLY_LANGUAGES:'en,fi,xx'})?.replyLanguages).toEqual(['en','fi']);
 });
});

describe('local Gemma Coach',()=>{
 it('words a rule-resolved answer from verified facts and keeps the exact amount and evidence',async()=>{
  const data=await loadDataset('organizer1'),network=ollama([{text:'You spent 30,97 € on taxis in August 2026. Open the transactions to see each ride.'}]);
  const result=await new LocalGemmaProvider(config,network).answer('How much did I spend on taxis last month?','en',10,{data});
  expect(result).toMatchObject({source:'model',diagnostic:'gemma_conversation_tool'});
  expect(result.message.metadata).toEqual({generatedConversation:true});
  expect(result.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097}});
  // Model metadata is verified before any question is sent; no ledger rows leave the server.
  expect(new URL(String(network.mock.calls[0][0])).pathname).toBe('/api/show');
  const payload=String(network.mock.calls[1][1]?.body);
  for(const row of data.transactions.slice(0,20))expect(payload).not.toContain(row.id);
  for(const [,init] of network.mock.calls)expect(init).toMatchObject({redirect:'error',cache:'no-store'});
 });
 it('maps an unfamiliar phrasing onto closed slots that the rules parse again',async()=>{
  const data=await loadDataset('organizer1'),network=ollama([slots({kind:'category_spend',category:'taxi',period:'named_month',month:'2026-07'}),{text:'You spent 226,57 € on taxis in July 2026. Open the transactions to see each ride.'}]);
  const result=await new LocalGemmaProvider(config,network).answer('how much went on cabs in july?','en',10,{data});
  expect(result.source).toBe('model');
  expect(result.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({input:{category:'taxi',period:{start:'2026-07-01',end:'2026-08-01'}},output:{netExpenses:22657}});
 });
 it('rejects invented figures and falls back to the reviewed local answer',async()=>{
  const data=await loadDataset('organizer1'),network=ollama([{text:'You spent 999,00 € on taxis in August 2026.'}]);
  const result=await new LocalGemmaProvider(config,network).answer('How much did I spend on taxis last month?','en',10,{data});
  expect(result).toMatchObject({source:'rule',diagnostic:'gemma_ungrounded'});
  expect(text(result.message.parts)).not.toContain('999');
  expect(result.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097}});
 });
 it('never answers a records question with small talk',async()=>{
  const data=await loadDataset('organizer1'),network=ollama([slots({kind:'reply',reply:'Your entertainment looks fine!'})]);
  const result=await new LocalGemmaProvider(config,network).answer('Kui palju kulutasin eelmisel kuul meelelahutusele ja muule?','et',10,{data});
  expect(result.source).toBe('rule');expect(text(result.message.parts)).not.toContain('looks fine');
  expect(mentionsRecords('how much on cabs last month')).toBe(true);expect(mentionsRecords('hi there')).toBe(false);
 });
 it('keeps general replies free of personal money claims',async()=>{
  const ok=await new LocalGemmaProvider(config,ollama([slots({kind:'reply',reply:'Hi! I can explain your spending and try what-if changes.'})])).answer('hi! what can you do?','en',10,{});
  expect(ok).toMatchObject({source:'model',diagnostic:'gemma_conversation'});
  const claim=await new LocalGemmaProvider(config,ollama([slots({kind:'reply',reply:'You have 4 000 € to spend.'})])).answer('hi! what can you do?','en',10,{});
  expect(claim).toMatchObject({source:'rule',diagnostic:'gemma_reply_ungrounded'});
 });
 it('keeps reviewed Finnish and Estonian wording unless those reply languages are enabled',async()=>{
  const data=await loadDataset('organizer1'),network=ollama([]);
  const result=await new LocalGemmaProvider(config,network).answer('Paljonko käytin takseihin viime kuussa?','fi',10,{data});
  expect(result).toMatchObject({source:'rule',diagnostic:'gemma_reviewed_wording'});
  expect(network.mock.calls.filter(([url])=>String(url).endsWith('/api/chat'))).toHaveLength(0);
 });
 it('refuses a server that serves a non-local or non-Gemma model before sending the question',async()=>{
  for(const info of [{...show,remote_host:'https://ollama.com'},{details:{format:'gguf',family:'llama'},model_info:{'general.architecture':'llama'}}]){
   const network=ollama([],info);
   const result=await new LocalGemmaProvider(config,network).answer('How much did I spend on taxis last month?','en',10,{data:await loadDataset('organizer1')});
   expect(result).toMatchObject({source:'rule',diagnostic:'gemma_not_local'});expect(network).toHaveBeenCalledTimes(1);
  }
 });
 it('falls back to rules when Ollama is down, and leaves exact amount search to the rules',async()=>{
  const down=vi.fn<typeof fetch>(async()=>{throw new TypeError('fetch failed');});
  expect(await new LocalGemmaProvider(config,down).answer('What kind of spender am I?','en',10,{})).toMatchObject({source:'rule',diagnostic:'gemma_unavailable'});
  const unused=ollama([]);
  expect(await new LocalGemmaProvider(config,unused).answer("Show last month's taxi rides over EUR 20.",'en',10,{data:await loadDataset('organizer1')})).toMatchObject({source:'rule',diagnostic:'gemma_amount_rules'});
  expect(unused).not.toHaveBeenCalled();
 });
 it('propagates user cancellation',async()=>{
  const controller=new AbortController();controller.abort();
  await expect(new LocalGemmaProvider(config,ollama([])).answer('What kind of spender am I?','en',10,{signal:controller.signal})).rejects.toBeInstanceOf(CoachCancelledError);
 });
});
