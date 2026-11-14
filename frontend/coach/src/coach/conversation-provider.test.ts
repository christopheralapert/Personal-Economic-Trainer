import {afterEach,describe,it,expect,vi} from 'vitest';
import {ConversationProvider,conversationFacts,cleanConversationText} from './conversation-provider';
import {loadDataset} from '@/engine/datasets';
import {CoachCancelledError} from './execution';
import {createComponentTools} from './catalog';
import {prepareCoachRequest} from './transport';
const august={start:'2026-08-01',end:'2026-09-01'},september={start:'2026-09-01',end:'2026-10-01'};
const response=(parts:unknown[])=>Response.json({candidates:[{content:{role:'model',parts},finishReason:'STOP'}],usageMetadata:{promptTokenCount:100,totalTokenCount:125}});
afterEach(()=>vi.useRealTimers());
function fake(name='showTransactions',args:Record<string,unknown>={period:august,category:'taxi'},text='You spent 30,97 € on taxis in August 2026. Review the matching rides before deciding what to change.'){
 return vi.fn<typeof fetch>(async(_url,init)=>{const body=JSON.parse(String(init?.body));return body.tools?response([{functionCall:{name,args}}]):response([{text:JSON.stringify({text})}]);});
}
describe('fresh conversational Gemini with server-owned evidence',()=>{
 it('writes an actual financial reply and keeps evidence, without sending rows or account identities',async()=>{
  const data=await loadDataset('organizer1'),network=fake(),provider=new ConversationProvider('fake-secret',network);
  for(let turn=0;turn<2;turn++){
   const answer=await provider.answer('How much did I spend on taxis last month?','en',10,{data});
   expect(answer).toMatchObject({source:'model',diagnostic:'model_conversation_tool',usage:{total_tokens:250},timing:{calls:2}});
   expect(answer.message.metadata).toEqual({generatedConversation:true});expect(answer.message.parts[0]).toMatchObject({text:expect.stringContaining('Review the matching rides')});
   expect(answer.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097}});
  }
  expect(network).toHaveBeenCalledTimes(4);
  for(const [url,init] of network.mock.calls){expect(String(url)).toContain('gemini-3.5-flash:generateContent');expect(init).toMatchObject({cache:'no-store',redirect:'error'});const payload=String(init?.body);for(const row of data.transactions.slice(0,15)){expect(payload).not.toContain(row.id);expect(payload).not.toContain(row.account_id);}expect(payload).not.toContain('"rows":');expect(payload).not.toContain('fake-secret');}
 });
 it('supports natural conversation and previous dialogue without forcing a chart',async()=>{
  const network=fake('reply',{text:'We can take this one habit at a time. What part of spending feels hardest to manage?'});
  const result=await new ConversationProvider('fake-key',network).answer('I feel overwhelmed by money','en',10,{}, {history:[{role:'user',text:'I want to feel more in control.'}]});
  expect(result).toMatchObject({source:'model',diagnostic:'model_conversation',timing:{calls:1}});expect(result.message.parts).toHaveLength(1);expect(result.message.parts[0]).toMatchObject({text:'We can take this one habit at a time. What part of spending feels hardest to manage?'});
  expect(JSON.parse(String(network.mock.calls[0][1]?.body)).contents[0].parts[0].text).toContain('I want to feel more in control.');
 });
 it('allows educational numbers in ordinary dialogue, but not unverified personal money claims',async()=>{
  for(const [text,source] of [['Try a 24-hour pause before an unplanned purchase.','model'],['Your balance is 999999.','rule'],['You spent 999999 EUR.','rule']] as const){const result=await new ConversationProvider('fake',fake('reply',{text})).answer('What is an impulse purchase?','en',10);expect(result.source).toBe(source);}
 });
 it('accepts typo spending guidance and uses the selected period for the same visible chart facts',async()=>{
  const data=await loadDataset('organizer1'),network=fake('showDonut',{period:september},'Your recorded spending in September 2026 was 7 017,40 €. Start by reviewing a flexible category and choosing a change that feels manageable.');
  const result=await new ConversationProvider('fake',network).answer('How can I fixs my spending?','en',10,{data,period:september});
  expect(result.source).toBe('model');expect(result.message.parts).toContainEqual(expect.objectContaining({type:'tool-showDonut',output:expect.objectContaining({period:september})}));
 });
 it('rejects changed selectors, multiple tools, invented totals and invalid provider prose',async()=>{
  const data=await loadDataset('organizer1');
  for(const network of [fake('showTransactions',{period:august,category:'dining'}),fake('reply',{text:'Just ignore the evidence.'}),fake('showTransactions',{period:august,category:'taxi'},'You spent 999999 € in August 2026.'),fake('showTransactions',{period:august,category:'taxi'},'You spent 30,97 € in July 2026.'),fake('showTransactions',{period:august,category:'taxi'},'<script>bad</script>')]){
   const result=await new ConversationProvider('fake',network).answer('How much did I spend on taxis last month?','en',10,{data});expect(result.source).toBe('rule');expect(JSON.stringify(result.message)).not.toContain('999999');
  }
  const network=vi.fn<typeof fetch>(async()=>response([{functionCall:{name:'showTransactions',args:{period:august,category:'taxi'}}},{functionCall:{name:'reply',args:{text:'extra'}}}]));
  expect((await new ConversationProvider('fake',network).answer('Taxi costs?','en',10,{data})).diagnostic).toBe('tool_validation');expect(network).toHaveBeenCalledTimes(1);
 });
 it('rejects amount-filtered searches before any provider request in EN FI ET',async()=>{
  const network=vi.fn<typeof fetch>();
  for(const [locale,question] of [['en','Show last month taxi rides over €20'],['fi','Näytä viime kuun yli 20 € taksimatkat'],['et','Näita eelmise kuu üle 20 € taksosõite']] as const){const result=await new ConversationProvider('fake',network).answer(question,locale,10);expect(result).toMatchObject({source:'rule',diagnostic:'unsupported_amount_filter',usage:null});expect(result.message.parts.every(part=>part.type==='text')).toBe(true);}expect(network).not.toHaveBeenCalled();
 });
 it('does not disclose provider errors and keeps fallback source honest after a failed explanation',async()=>{
  const network=vi.fn<typeof fetch>(async()=>Response.json({error:{status:'RESOURCE_EXHAUSTED',message:'secret provider internals'}},{status:429}));
  const result=await new ConversationProvider('fake',network).answer('Hello','en',10);expect(result).toMatchObject({source:'rule',diagnostic:'provider_http:429:RESOURCE_EXHAUSTED'});expect(JSON.stringify(result)).not.toContain('secret provider');expect(network).toHaveBeenCalledTimes(1);
  const fail=fake();fail.mockImplementationOnce(async()=>response([{functionCall:{name:'showTransactions',args:{period:august,category:'taxi'}}}])).mockImplementationOnce(async()=>Response.json({}, {status:503}));
  const fallback=await new ConversationProvider('fake',fail).answer('How much did I spend on taxis last month?','en',10,{data:await loadDataset('organizer1')});expect(fallback).toMatchObject({source:'rule',usage:{total_tokens:125}});expect(fallback.message.parts.find(part=>part.type==='tool-showTransactions')).toMatchObject({output:{netExpenses:3097}});
 });
 it('cancels before dispatch and after a late provider response, and disposes the timeout',async()=>{
  const controller=new AbortController(),network=fake();controller.abort();await expect(new ConversationProvider('fake',network).answer('Hi','en',10,{signal:controller.signal})).rejects.toBeInstanceOf(CoachCancelledError);expect(network).not.toHaveBeenCalled();
  const late=new AbortController();const held=fake('reply',{text:'Hello there.'});held.mockImplementationOnce(async()=>{late.abort();return response([{functionCall:{name:'reply',args:{text:'Late reply'}}}]);});await expect(new ConversationProvider('fake',held).answer('Hi','en',10,{signal:late.signal})).rejects.toBeInstanceOf(CoachCancelledError);
  vi.useFakeTimers();const stalled=vi.fn<typeof fetch>(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true});}));
  const pending=new ConversationProvider('fake',stalled).answer('Hello','en',10);await vi.advanceTimersByTimeAsync(20000);expect(await pending).toMatchObject({source:'rule',diagnostic:'conversation_timeout'});expect(vi.getTimerCount()).toBe(0);
 });
 it('sanitizes dialogue and sends text-only bounded history, not client tool output',async()=>{
  expect(cleanConversationText('Contact alice@example.test on FI21 1234 5600 0007 85')).not.toContain('alice@example');
  const prepared=await prepareCoachRequest({messages:[{id:'a',role:'assistant',parts:[{type:'text',text:'Earlier advice'},{type:'tool-showTransactions',toolCallId:'x',state:'output-available',input:{},output:{secret:'must-not-send'}}]},{id:'b',role:'user',parts:[{type:'text',text:'Can you explain that?'}]}] as never,body:{privacy:false}} as never);
  expect(JSON.stringify(prepared)).toContain('Earlier advice');expect(JSON.stringify(prepared)).not.toContain('must-not-send');
 });
 it('builds only aggregate evidence from the exact scoped server result',async()=>{
  const data=await loadDataset('organizer1'),tool=createComponentTools(10,data).showTransactions,output=await tool.execute!({period:august,category:'taxi'},{} as never);
  const facts=conversationFacts('showTransactions',{period:august,category:'taxi'},output,'fi');expect(facts).toMatchObject({amount:expect.stringContaining('30,97'),period:august,verifiedSummary:expect.stringContaining('elokuussa 2026')});expect(JSON.stringify(facts)).not.toContain('account_id');expect(JSON.stringify(facts)).not.toContain('rows');
 });
});
