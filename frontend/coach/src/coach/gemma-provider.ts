import 'server-only';
import {z} from 'zod';
import {createComponentTools,type CoachMessage,type ToolName} from './catalog';
import {answerFromTool} from './answer';
import {resolveQuestion} from './resolve-question';
import {adaptIntentToData,requestForIntent,type FinancialIntent} from './intent';
import {amountSelection} from './amount-search';
import {categoryAliases,conceptRequests} from './query-language';
import {RuleProvider} from './rule-provider';
import {conversationFacts,generalReply,groundedReply,cleanConversationText,type ConversationOptions} from './conversation-provider';
import {throwIfCancelled,type CoachExecution} from './execution';
import {sourceDate} from '@/engine/source-date';
import {demo,monthPeriod,UnavailableScenarioError} from '@/engine';
import type {Locale} from '@/i18n/dictionaries';

/**
 * Local Gemma through an Ollama server on this machine. Privacy mode only.
 *
 * Gemma never selects tools, accounts or amounts directly. It may (1) map a question
 * the local rules did not understand onto closed slots that are rebuilt into a
 * canonical question and re-parsed by the same deterministic rules, and (2) word the
 * reply from verified aggregate facts, checked by the same grounding rules as Gemini.
 * Any failure returns the local-rule answer; nothing ever falls back to a cloud model.
 */
export type GemmaConfig={url:string;model:string;timeoutMs:number;replyLanguages:string[]};
const MAX_RESPONSE_BYTES=65536;

/** Literal loopback HTTP only. A flag alone never sends questions anywhere. */
export function gemmaConfig(env:Record<string,string|undefined>):GemmaConfig|null{
 if(env.MONEY_COACH_LOCAL_GEMMA_ENABLED!=='true')return null;
 const model=env.MONEY_COACH_LOCAL_GEMMA_MODEL??'gemma3:4b',raw=env.MONEY_COACH_LOCAL_GEMMA_URL??'http://127.0.0.1:11434';
 if(!/^[a-z0-9][a-z0-9._:-]{0,79}$/iu.test(model) || /cloud/iu.test(model))return null;
 try{
  const url=new URL(raw);
  if(url.protocol!=='http:' || !['127.0.0.1','localhost','[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['','/'].includes(url.pathname))return null;
  const timeout=Number(env.MONEY_COACH_LOCAL_GEMMA_TIMEOUT_MS??'30000');
  const replyLanguages=(env.MONEY_COACH_LOCAL_GEMMA_REPLY_LANGUAGES??'en').split(',').map(value=>value.trim()).filter(value=>['en','fi','et','de','sv'].includes(value));
  return {url:url.origin,model,timeoutMs:Number.isInteger(timeout) && timeout>=1000 && timeout<=120000 ? timeout : 30000,replyLanguages};
 }catch{return null;}
}

const kinds=['category_spend','transactions','where_money_went','baskets','spender_type','safe_to_spend','safe_to_save','payday','what_if','compare','concept','reply','unclear'] as const;
const concepts=['none','fund','cashflow','habit','basketConcept','safeConcept','savingConcept'] as const;
/** English phrases the deterministic parser accepts; checked against the alias table at use. */
const categoryPhrase:Record<string,string>={taxi:'taxis',dining:'dining out',home_tech:'home and technology',investment:'investments'};
const languageName:Record<string,string>={en:'English',fi:'Finnish',et:'Estonian',de:'German',sv:'Swedish',es:'Spanish',ja:'Japanese'};
const monthName=(start:string,language='en')=>new Intl.DateTimeFormat(language,{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(start+'T12:00:00Z'));

const periodWords=/\b(?:last|this|previous) (?:month|week)\b|viime|tässä kuussa|tällä viikolla|eelmisel|sel kuul|sel nädalal/iu;
const escapeRegExp=(value:string)=>value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');
/** Small talk may never answer a message that names a spending category or period. */
export function mentionsRecords(question:string){
 const text=question.toLocaleLowerCase();
 return periodWords.test(text) || Object.keys(categoryAliases).some(alias=>new RegExp(`(?<!\\p{L})${escapeRegExp(alias)}(?!\\p{L})`,'u').test(text));
}
class GemmaError extends Error{constructor(readonly diagnostic:string){super('Local Gemma unavailable');}}
let busy=false;

export class LocalGemmaProvider{
 constructor(private config:GemmaConfig,private network:typeof fetch=globalThis.fetch){}

 private async post(path:string,body:unknown,signal:AbortSignal){
  const response=await this.network(this.config.url+path,{method:'POST',cache:'no-store',redirect:'error',signal,headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(body)});
  if(!response.ok)throw new GemmaError(`gemma_http:${response.status}`);
  const reader=response.body?.getReader();if(!reader)throw new GemmaError('gemma_response_invalid');
  const chunks:Uint8Array[]=[];let length=0;
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>MAX_RESPONSE_BYTES){void reader.cancel();throw new GemmaError('gemma_response_size');}chunks.push(part.value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try{return JSON.parse(new TextDecoder().decode(bytes)) as Record<string,unknown>;}catch{throw new GemmaError('gemma_response_invalid');}
 }

 /** Ollama can also proxy hosted models: confirm local GGUF Gemma weights before any question is sent. */
 private async verifyLocal(signal:AbortSignal){
  const info=await this.post('/api/show',{model:this.config.model},signal);
  const details=info.details as Record<string,unknown>|undefined,modelInfo=info.model_info as Record<string,unknown>|undefined;
  if(!details || !modelInfo || details.format!=='gguf' || !String(details.family??'').startsWith('gemma') || !String(modelInfo['general.architecture']??'').startsWith('gemma') || info.remote_host || info.remote_model)throw new GemmaError('gemma_not_local');
 }

 private async chat(system:string,user:string,schema:Record<string,unknown>,maxTokens:number,signal:AbortSignal){
  const result=await this.post('/api/chat',{model:this.config.model,stream:false,format:schema,keep_alive:'30m',
   options:{temperature:0,num_predict:maxTokens,num_ctx:4096},messages:[{role:'system',content:system},{role:'user',content:user}]},signal);
  const message=result.message as {role?:unknown;content?:unknown;tool_calls?:unknown}|undefined;
  if(result.model!==this.config.model || result.done!==true || result.done_reason!=='stop' || message?.role!=='assistant' || message.tool_calls || typeof message.content!=='string' || message.content.length>8192)throw new GemmaError('gemma_response_invalid');
  try{return JSON.parse(message.content) as unknown;}catch{throw new GemmaError('gemma_response_invalid');}
 }

 async answer(question:string,locale:Locale,savingsPercent:number,execution:CoachExecution={},options:ConversationOptions={}){
  throwIfCancelled(execution.signal);
  const language=options.language??locale,data=execution.data??demo,reference=sourceDate(data.as_of);
  const started=performance.now();let calls=0;
  const timing=()=>({modelMs:Math.round(performance.now()-started),calls});
  const fallback=async(diagnostic:string)=>({message:await new RuleProvider().answer(question,locale,savingsPercent,execution),source:'rule' as const,diagnostic,timing:timing()});
  let intent=adaptIntentToData(resolveQuestion(question,execution.context,execution.period,reference),data);
  // Exact amount search stays entirely with the deterministic parser.
  if(amountSelection(question).present)return fallback('gemma_amount_rules');
  if(intent.status!=='ready' && intent.reason==='INVALID_QUESTION')return fallback('invalid_question');
  if(busy)return fallback('gemma_busy');
  busy=true;
  const controller=new AbortController(),cancel=()=>controller.abort();execution.signal?.addEventListener('abort',cancel,{once:true});
  const timer=setTimeout(cancel,this.config.timeoutMs);
  try{
   await this.verifyLocal(controller.signal);
   let interpretedByGemma=false;
   if(intent.status!=='ready'){
    calls++;interpretedByGemma=true;
    const interpreted=await this.interpret(question,language,reference,data,controller.signal);
    throwIfCancelled(execution.signal);
    if(interpreted.kind==='reply'){
     if(mentionsRecords(question) || !this.config.replyLanguages.includes(language))return fallback(mentionsRecords(question) ? 'gemma_reply_needs_records' : 'gemma_reply_language');
     const text=generalReply(interpreted.reply);
     if(text===null)return fallback('gemma_reply_ungrounded');
     return {message:{id:crypto.randomUUID(),role:'assistant',parts:[{type:'text',text}],metadata:{generatedConversation:true}} as CoachMessage,source:'model' as const,diagnostic:'gemma_conversation',timing:timing()};
    }
    if(interpreted.question===null)return fallback('gemma_unclear');
    intent=adaptIntentToData(resolveQuestion(interpreted.question,undefined,execution.period,reference),data);
    if(intent.status!=='ready')return fallback('gemma_unresolved');
   }
   const ready=intent as Extract<FinancialIntent,{status:'ready'}>;
   const {name,input}=requestForIntent(ready),tools=createComponentTools(savingsPercent,data),tool=tools[name as ToolName];
   const parsed=(tool.inputSchema as z.ZodType<Record<string,unknown>>).parse(input);
   let output:unknown;
   try{output=await (tool.execute as (value:unknown,options:unknown)=>Promise<unknown>)(parsed,{toolCallId:crypto.randomUUID(),messages:[]});}
   catch(error){if(error instanceof UnavailableScenarioError)return fallback('gemma_scenario_unavailable');throw error;}
   throwIfCancelled(execution.signal);
   // Reviewed lessons are shown verbatim; Gemma only helped find the right one.
   // Small local models write weaker Finnish/Estonian, so by default those replies keep
   // the reviewed local wording; Gemma still helps interpret the question.
   if(name==='showConcept' || !this.config.replyLanguages.includes(language))return {message:answerFromTool(name as ToolName,parsed,output,locale),source:interpretedByGemma ? 'model' as const : 'rule' as const,diagnostic:interpretedByGemma ? 'gemma_interpreted' : 'gemma_reviewed_wording',timing:timing()};
   const facts=conversationFacts(name as ToolName,parsed,output,language);
   calls++;
   const composed=await this.compose(question,language,facts,controller.signal);
   const text=groundedReply(composed,facts,language);
   throwIfCancelled(execution.signal);
   const answer=answerFromTool(name as ToolName,parsed,output,locale);
   if(text===null)return {message:answer,source:'rule' as const,diagnostic:'gemma_ungrounded',timing:timing()};
   answer.parts=[{type:'text',text},...answer.parts.filter(part=>part.type!=='text')];answer.metadata={generatedConversation:true};
   return {message:answer,source:'model' as const,diagnostic:'gemma_conversation_tool',timing:timing()};
  }catch(error){
   throwIfCancelled(execution.signal);
   return fallback(controller.signal.aborted?'gemma_timeout':error instanceof GemmaError?error.diagnostic:error instanceof z.ZodError?'gemma_validation':'gemma_unavailable');
  }finally{busy=false;clearTimeout(timer);execution.signal?.removeEventListener('abort',cancel);}
 }

 /** Closed slots only. The canonical question is rebuilt here and parsed again by the rules. */
 private async interpret(question:string,language:string,reference:string,data:typeof demo,signal:AbortSignal):Promise<{kind:'reply';reply:string}|{kind:'question';question:string|null}>{
  const categories=[...new Set(data.transactions.filter(row=>row.economic_flow==='expense').map(row=>row.category))].filter(key=>categoryAliases[categoryPhrase[key]??key]===key).sort();
  const schema={type:'object',additionalProperties:false,required:['kind','category','period','month','percent','concept','amount_eur','delay_days','reply'],properties:{amount_eur:{type:'integer',minimum:0,maximum:100000},delay_days:{type:'integer',minimum:0,maximum:14},
   kind:{type:'string',enum:kinds},category:{type:'string',enum:['none',...categories]},period:{type:'string',enum:['last_month','this_month','named_month','none']},
   month:{type:'string',pattern:'^(none|20[0-9]{2}-(0[1-9]|1[0-2]))$'},percent:{type:'integer',minimum:0,maximum:100},concept:{type:'string',enum:concepts},reply:{type:'string',maxLength:600}}};
  const last=monthPeriod(reference,-1);
  const system=[
   'You route a bank customer\'s message for Money Coach, a personal finance coach. Return JSON only.',
   'kind: category_spend = money spent on one category (set category and period); transactions = list transactions for a period; where_money_went = spending breakdown; baskets = the three spending baskets; spender_type = what kind of spender they are; safe_to_spend = how much is safe to spend this week; safe_to_save = how much is safe to save; payday = money per day until payday, affording a planned purchase (set amount_eur) or a late salary (set delay_days); what_if = saving from cutting one category by a percentage (set category and percent); compare = compare with other people; concept = explain a money concept (set concept); reply = greeting, thanks or a general money question that does not need their records; unclear = anything else.',
   `Concepts: fund = emergency fund, cashflow = cash flow, habit = small habit change, basketConcept = the three baskets, safeConcept = safe to spend, savingConcept = safe to save.`,
   `Categories: ${categories.join(', ')}. taxi = taxis or cabs; dining = restaurants, cafes or eating out; home_tech = home goods and electronics.`,
   `Today is ${reference}. last_month is ${monthName(last.start)}. For an explicitly named month use period named_month and month YYYY-MM; otherwise month none.`,
   `For kind reply, write at most three short sentences in ${languageName[language]??'English'} without any amounts or numbers; otherwise reply is an empty string.`,
   'The user may write in English, Finnish, Estonian, German or Swedish. Never invent information.',
   'Examples:',
   `"how much went on cabs in july?" -> {"kind":"category_spend","category":"taxi","period":"named_month","month":"${reference.slice(0,4)}-07",...}`,
   '"If I ate out 20% less, what would I save?" -> {"kind":"what_if","category":"dining","percent":20,...}',
   '"Kui palju kulutasin eelmisel kuul meelelahutusele?" -> {"kind":"category_spend","category":"entertainment","period":"last_month",...}',
   '"Mihin rahani menivät?" -> {"kind":"where_money_went","period":"last_month",...}',
   '"Mikä on hätävara?" -> {"kind":"concept","concept":"fund",...}',
   '"Can I buy a 350 euro phone before payday?" -> {"kind":"payday","amount_eur":350,"delay_days":0,...}',
   '"Kui palju saan päevas kulutada, kui palk tuleb 5 päeva hiljem?" -> {"kind":"payday","amount_eur":0,"delay_days":5,...}',
   '"Thanks, that helps!" -> {"kind":"reply","reply":"You are welcome! Ask me about any category or month whenever you like.",...}'].join('\n');
  const slots=z.object({kind:z.enum(kinds),category:z.string(),period:z.enum(['last_month','this_month','named_month','none']),month:z.string(),percent:z.number().int().min(0).max(100),concept:z.enum(concepts),amount_eur:z.number().int().min(0).max(100000),delay_days:z.number().int().min(0).max(14),reply:z.string().max(600)}).strict()
   .parse(await this.chat(system,cleanConversationText(question),schema,160,signal));
  if(slots.kind==='reply')return {kind:'reply',reply:slots.reply};
  const category=slots.category!=='none' && categories.includes(slots.category) ? categoryPhrase[slots.category]??slots.category : null;
  const named=slots.period==='named_month' && /^\d{4}-\d{2}$/u.test(slots.month) && `${slots.month}-01`<=reference ? `in ${monthName(`${slots.month}-01`)}` : null;
  const when=named ?? (slots.period==='this_month' ? 'this month' : 'last month');
  const concept=slots.concept!=='none' ? Object.entries(conceptRequests).find(([,value])=>value===slots.concept)?.[0] ?? null : null;
  const canonical:Record<typeof kinds[number],string|null>={
   category_spend:category && `How much did I spend on ${category} ${when}?`,
   transactions:`Show transactions ${when}`,
   where_money_went:named ? `Show transactions ${when}` : `Where did my money go ${when}?`,
   baskets:'Show my three baskets',spender_type:'What kind of spender am I?',
   safe_to_spend:'What is safe for me to spend this week?',safe_to_save:'What is safe for me to save?',
   payday:slots.amount_eur>0 ? `Can I afford a ${slots.amount_eur} € purchase?` : slots.delay_days>0 ? `What if my salary is ${slots.delay_days} days late?` : 'How much can I spend per day until payday?',
   what_if:category && slots.percent>0 ? `How much could I save if I reduced ${category} by ${slots.percent}%?` : null,
   compare:'Compare me to others',concept,reply:null,unclear:null};
  return {kind:'question',question:canonical[slots.kind]};
 }

 private async compose(question:string,language:string,facts:ReturnType<typeof conversationFacts>,signal:AbortSignal){
  const period=facts.period ? (monthPeriod(facts.period.start).start===facts.period.start && monthPeriod(facts.period.start).end===facts.period.end ? monthName(facts.period.start,language) : `${facts.period.start} – ${facts.period.end}`) : null;
  const system=[`You are Money Coach, a friendly personal finance coach. Write the reply in ${languageName[language]??'English'} as plain text, two or three short sentences, no Markdown.`,
   'Use ONLY verifiedFacts for anything about the user. Never calculate, round or invent numbers, transactions or categories.',
   facts.amount ? `You must include this exact amount text: ${facts.amount}.` : 'Do not write any amounts.',
   'payday' in facts ? 'verifiedFacts.amount is the amount the user can spend PER DAY until payday, not a total. Say "a day" or "per day" with it.' : '',
   period ? `You must name the period exactly as: ${period}.` : '',
   'Records may be partial; say so briefly. Do not ask the user for information: the app already shows the details and evidence next to your reply.',
   'End with one practical next step the user can take in this app, such as opening the transactions, trying a What if reduction or checking the three baskets. Return JSON with text.'].filter(Boolean).join('\n');
  const result=z.object({text:z.string().trim().min(1).max(1500)}).strict().parse(await this.chat(system,JSON.stringify({question:cleanConversationText(question),verifiedFacts:facts}),
   {type:'object',additionalProperties:false,required:['text'],properties:{text:{type:'string',maxLength:1500}}},400,signal));
  // Small models sometimes wrap the reply in stray quotation marks.
  return result.text.trim().replace(/^["'“”„]+|["'“”„]+$/gu,'').trim();
 }
}
