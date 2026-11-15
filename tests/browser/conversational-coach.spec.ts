import {readFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {test,expect,type Page,type Route,type Response} from '@playwright/test';

// Mocked SSE proves browser rendering/transport only. It cannot intercept server fetch.
// @real tests leave /api/chat untouched and require an explicitly opted-in server.
// No claim of upstream payload inspection (including verifiedFacts) is made here.
const entry='/demo?dataset=organizer1&tab=coach';
const taxiQuestion='How much did I spend on taxis last month?';
const spendingQuestions=['How can I fixs my spending?','How can I fix my spending?'];
const modelLabel='Answered with a model',localLabel='Answered with local rules';
const assistants=(page:Page)=>page.locator('[data-message-role="assistant"]');
type ChatBody={privacy:boolean;dataset:string;messages:{role:string;parts:{type:string;text?:string}[]}[];context?:unknown};
type ToolResult={name:string;input:unknown;output:unknown};
type FixtureRow={id:string;account_id:string;amount_minor:number;booked_on:string;category:string;merchant:string;status:string;economic_flow:string};
const fixture=JSON.parse(readFileSync(path.resolve(__dirname,'../../frontend/coach/data/organizer-1.v1.json'),'utf8')) as {profiles:{transactions:FixtureRow[]}[]};

function taxiTool(month:'07'|'08'):ToolResult {
 const period={start:`2026-${month}-01`,end:month==='08'?'2026-09-01':'2026-08-01'};
 const rows=fixture.profiles[0].transactions.filter(row=>row.category==='taxi' && row.status==='booked' && row.booked_on>=period.start && row.booked_on<period.end)
  .sort((a,b)=>b.booked_on.localeCompare(a.booked_on));
 return {name:'showTransactions',input:{period,category:'taxi'},output:{period,filters:{category:'taxi'},rows,
  page:0,pageSize:25,total:rows.length,financialCount:rows.length,netExpenses:-rows.reduce((sum,row)=>sum+row.amount_minor,0)}};
}

async function openCoach(page:Page,privacy=false) {
 await page.addInitScript(value=>{
  localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale:'en',savings:10}));
  localStorage.setItem('money-coach-privacy.v1',String(value));
 },privacy);
 await page.goto(entry);
 await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toBeEditable();
}

async function submit(page:Page,question:string) {
 const count=await assistants(page).count();
 await page.getByRole('textbox',{name:'Your question',exact:true}).fill(question);
 await page.getByRole('button',{name:'Send question',exact:true}).click();
 await expect(assistants(page)).toHaveCount(count+1);
 await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toBeEditable();
 return assistants(page).nth(count);
}

async function mockReply(route:Route,text:string,tool?:ToolResult) {
 const revision=route.request().headers()['x-money-coach-revision'];
 expect(revision,'Browser must send the current build identity').toBeTruthy();
 const id=randomUUID(),textId=`${id}-text`,toolCallId=`${id}-tool`;
 const middle=Math.floor(text.length/2);
 const events:Record<string,unknown>[]=[
  {type:'start',messageId:id,messageMetadata:{answerMode:'model',generatedConversation:true,language:'en'}},
  {type:'start-step'},{type:'text-start',id:textId},
  {type:'text-delta',id:textId,delta:text.slice(0,middle)},
  {type:'text-delta',id:textId,delta:text.slice(middle)},{type:'text-end',id:textId},
 ];
 if(tool)events.push({type:'tool-input-available',toolCallId,toolName:tool.name,input:tool.input},
  {type:'tool-output-available',toolCallId,output:tool.output});
 events.push({type:'finish-step'},{type:'finish'});
 await route.fulfill({status:200,headers:{'content-type':'text/event-stream','x-vercel-ai-ui-message-stream':'v1',
  'x-money-coach-revision':revision,'cache-control':'private, no-store','x-money-coach-source':'model',
  'x-money-coach-provider':'gemini-direct-mock','x-money-coach-evaluation':tool?'model_conversation_tool':'model_conversation'},
  body:events.map(event=>`data: ${JSON.stringify(event)}\n\n`).join('')+'data: [DONE]\n\n'});
}

test.describe('mocked SSE browser contract',()=>{
 for(const question of spendingQuestions)test(`renders a conversational reply for "${question}"`,async({page})=>{
  const requests:ChatBody[]=[],text='Start with the spending that feels hardest to control. Which purchases would you like to change?';
  await page.route('**/api/chat',async route=>{requests.push(route.request().postDataJSON());await mockReply(route,text);});
  await openCoach(page);
  const answer=await submit(page,question);
  await expect(answer.locator('[data-conversation-reply]')).toHaveText(text);
  await expect(answer.getByText(modelLabel,{exact:true})).toBeVisible();
  await expect(answer.getByText(localLabel,{exact:true})).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({dataset:'organizer1',privacy:false,messages:[{role:'user',parts:[{type:'text',text:question}]}]});
 });

 test('ordinary conversation carries bounded text history into a follow-up',async({page})=>{
  const requests:ChatBody[]=[],first='An impulse purchase is an unplanned choice. Pausing can help you decide whether it matters to you.';
  const second='For those impulse purchases, put the item on a wish list and revisit it after a pause.';
  await page.route('**/api/chat',async route=>{requests.push(route.request().postDataJSON());await mockReply(route,requests.length===1?first:second);});
  await openCoach(page);
  await submit(page,'What is an impulse purchase?');
  const answer=await submit(page,'How could I avoid those?');
  await expect(answer.locator('[data-conversation-reply]')).toHaveText(second);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages).toEqual([
   {role:'user',parts:[{type:'text',text:'What is an impulse purchase?'}]},
   {role:'assistant',parts:[{type:'text',text:first}]},
   {role:'user',parts:[{type:'text',text:'How could I avoid those?'}]},
  ]);
  await expect(assistants(page).first().locator('[data-conversation-reply]')).toHaveText(first);
 });

 test('generated taxi reply coexists with August evidence and keeps selectors for July',async({page})=>{
  const requests:ChatBody[]=[];
  await page.route('**/api/chat',async route=>{
   requests.push(route.request().postDataJSON());const august=requests.length===1;
   await mockReply(route,august?'Your partial records show 30,97 € on taxis in August 2026. Consider planning the next trip in advance.':
    'Your partial records show 226,57 € on taxis in July 2026. Review which trips you could combine.',taxiTool(august?'08':'07'));
  });
  await openCoach(page);
  const first=await submit(page,taxiQuestion);
  await expect(first.locator('[data-conversation-reply]')).toContainText('30,97 €');
  await expect(first.locator('[data-conversation-reply]')).toContainText('August 2026');
  await expect(first.getByText(modelLabel,{exact:true})).toBeVisible();
  await first.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();
  const detail=page.getByRole('dialog');
  await expect(detail).toContainText('30,97');await expect(detail).toContainText('MRC-TRN-0063');
  await expect(detail).toContainText('26.8.2026');
  await detail.getByRole('button',{name:'Done',exact:true}).click();
  const followup=await submit(page,'What about the month before?');
  await expect(followup.locator('[data-conversation-reply]')).toContainText('July 2026');
  await expect(followup.locator('[data-spoken-answer]')).toContainText('226,57');
  expect(requests).toHaveLength(2);
  expect(requests[1].context).toEqual({tool:'showTransactions',input:{period:{start:'2026-08-01',end:'2026-09-01'},category:'taxi'}});
  expect(requests[1].messages.flatMap(message=>message.parts).every(part=>part.type==='text')).toBe(true);
  await expect(first.locator('[data-conversation-reply]')).toContainText('August 2026');
 });

 test('editing a what-if slider hides stale generated prose and updates the local spoken result',async({page})=>{
  const period={start:'2026-09-01',end:'2026-10-01'};
  const baseline=-fixture.profiles[0].transactions.filter(row=>row.category==='dining' && row.status==='booked'
   && ['expense','refund'].includes(row.economic_flow) && row.booked_on>=period.start && row.booked_on<period.end)
   .reduce((sum,row)=>sum+row.amount_minor,0);
  expect(baseline).toBe(79788);
  const text='A 20% reduction from your recorded 797,88 € dining spending in September 2026 would be 159,58 € per month. These are partial historical records.';
  const tool:ToolResult={name:'showWhatIf',input:{category:'dining',pct:20,period},output:{category:'dining',initialPct:20,period,
   result:{category:'dining',pct:20,baseline,monthly:15958,annual:191496,incomeShare:null,period,observed:true}}};
  let requests=0;
  await page.route('**/api/chat',async route=>{requests++;await mockReply(route,text,tool);});
  await openCoach(page);
  const answer=await submit(page,'What if I cut dining by 20% in September 2026?');
  await expect(answer.locator('[data-conversation-reply]')).toHaveText(text);
  await expect(answer.locator('[data-spoken-answer]')).toContainText('159,58');
  const slider=answer.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuenow','20');
  await slider.focus();await slider.press('Home');
  for(let index=0;index<30;index++)await slider.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuenow','30');
  await expect(answer.locator('[data-spoken-answer]')).toContainText('239,36');
  expect(requests,'Slider edits must compute locally without another hosted chat request').toBe(1);
  await expect(answer.locator('[data-conversation-reply]')).toHaveCount(0);
  await expect(answer).not.toContainText(text);
  await expect(answer.getByText(modelLabel,{exact:true})).toBeVisible();
 });

 test('identical questions request fresh replies and reload restores no generated answers',async({page})=>{
  const requests:ChatBody[]=[],replies=['Review the purchases that matter least to you.','Choose a small spending habit you would like to change.','Plan your next purchase before you make it.'];
  await page.route('**/api/chat',async route=>{requests.push(route.request().postDataJSON());await mockReply(route,replies[requests.length-1]);});
  await page.addInitScript(()=>{
   localStorage.setItem('money-coach-generated.old','STALE GENERATED ANSWER');
   sessionStorage.setItem('money-coach-thread.old','STALE THREAD ANSWER');
  });
  await openCoach(page);
  const first=await submit(page,spendingQuestions[0]),id=await first.getAttribute('data-message-id');
  await expect(first.locator('[data-conversation-reply]')).toHaveText(replies[0]);
  const second=await submit(page,spendingQuestions[0]);
  await expect(second.locator('[data-conversation-reply]')).toHaveText(replies[1]);
  expect(await second.getAttribute('data-message-id')).not.toBe(id);
  expect(requests).toHaveLength(2);
  await page.reload();await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toBeEditable();
  await expect(assistants(page)).toHaveCount(0);
  expect(await page.evaluate(()=>[localStorage.getItem('money-coach-generated.old'),sessionStorage.getItem('money-coach-thread.old')])).toEqual([null,null]);
  const third=await submit(page,spendingQuestions[0]);
  await expect(third.locator('[data-conversation-reply]')).toHaveText(replies[2]);
  expect(requests).toHaveLength(3);expect(requests[2].messages).toHaveLength(1);
 });
});

test('privacy mode uses the local chat route and no browser hosted speech or translation',async({page})=>{
 const hosted:string[]=[],chat:ChatBody[]=[];
 // Abort safely even on regression: no accidental live-provider request escapes.
 await page.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.pathname==='/api/chat')chat.push(route.request().postDataJSON());
  if(/^\/api\/(voice|language)(\/|$)/u.test(url.pathname) || /(?:googleapis\.com|openai\.com)$/u.test(url.hostname)){
   hosted.push(url.pathname);await route.abort();
  }else await route.continue();
 });
 await openCoach(page,true);
 const answer=await submit(page,taxiQuestion);
 await expect(answer.getByText(localLabel,{exact:true})).toBeVisible();
 await expect(answer.locator('[data-spoken-answer]')).toContainText('30,97');
 await expect(answer.locator('[data-conversation-reply]')).toHaveCount(0);
 expect(hosted,'Privacy must bypass hosted speech and translation').toEqual([]);
 expect(chat).toHaveLength(1);expect(chat[0].privacy).toBe(true);
 // Server unit tests assert zero provider requests for this privacy=true path.
});

test('unavailable chat endpoint is labelled local and retains financial evidence',async({page})=>{
 let requests=0;
 await page.route('**/api/chat',async route=>{requests++;await route.fulfill({status:503,body:'',headers:{'cache-control':'private, no-store'}});});
 await openCoach(page);
 const answer=await submit(page,taxiQuestion);
 await expect(answer.getByText(localLabel,{exact:true})).toBeVisible();
 await expect(answer.locator('[data-conversation-reply]')).toHaveCount(0);
 await expect(answer.locator('[data-spoken-answer]')).toContainText('30,97');
 await expect(answer.locator('[data-spoken-answer]')).toContainText('August 2026');
 expect(requests).toBe(1);
});

test('production server with provider disabled reports a local answer',async({page})=>{
 test.skip(Boolean(process.env.CONVERSATION_COACH_URL) && process.env.CONVERSATION_COACH_UNAVAILABLE_TEST!=='true',
  'External server must explicitly opt into the unavailable-provider scenario');
 await openCoach(page);
 const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/chat');
 const answer=await submit(page,taxiQuestion),response=await pending;
 expect(response.status()).toBe(200);expect(response.headers()['x-money-coach-source']).toBe('rule');
 expect(response.headers()['x-money-coach-provider']).toBeUndefined();
 expect(response.headers()['cache-control']).toContain('no-store');
 await expect(answer.getByText(localLabel,{exact:true})).toBeVisible();
 await expect(answer.locator('[data-conversation-reply]')).toHaveCount(0);
});

async function realReply(page:Page,question:string,calls?:1|2) {
 const started=performance.now();
 const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/chat');
 const answer=await submit(page,question),response:Response=await pending,headers=response.headers();
 const receipt={question,elapsedMs:Math.round(performance.now()-started),source:headers['x-money-coach-source'],
  provider:headers['x-money-coach-provider'],evaluation:headers['x-money-coach-evaluation'],
  timing:headers['x-money-coach-usage']?JSON.parse(headers['x-money-coach-usage']):null};
 await test.info().attach('real-conversation-receipt',{body:JSON.stringify(receipt),contentType:'application/json'});
 console.log(JSON.stringify(receipt));
 expect(response.status()).toBe(200);
 expect(headers['x-money-coach-source'],headers['x-money-coach-evaluation']).toBe('model');
 expect(headers['x-money-coach-provider']).toBe('gemini-direct');
 expect(headers['cache-control']).toContain('no-store');
 expect([1,2]).toContain(receipt.timing?.calls);
 if(calls)expect(receipt.timing).toMatchObject({calls});
 expect(headers['x-money-coach-evaluation']).toBe(receipt.timing.calls===1?'model_conversation':'model_conversation_tool');
 await expect(answer.locator('[data-conversation-reply]')).toBeVisible();
 await expect(answer.getByText(modelLabel,{exact:true})).toBeVisible();
 return {answer,response};
}

test.describe('@real native Gemini conversation through the production server',()=>{
 test.skip(process.env.MONEY_COACH_REAL_CONVERSATION_TEST!=='true','Explicit synthetic real-provider opt-in required; no browser route mocks');

 test('Finnish taxi answer names August 2026 and opens the real synthetic transaction',async({page})=>{
  await page.addInitScript(()=>{
   localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale:'fi',savings:10}));
   localStorage.setItem('money-coach-privacy.v1','false');
  });
  await page.goto(entry);
  const pending=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/chat');
  const started=performance.now();
  await page.getByRole('textbox',{name:'Kysymyksesi',exact:true}).fill('Paljonko käytin takseihin viime kuussa?');
  await page.getByRole('button',{name:'Lähetä kysymys',exact:true}).click();
  const response=await pending,headers=response.headers(),answer=assistants(page).last();
  expect(headers['x-money-coach-source'],headers['x-money-coach-evaluation']).toBe('model');
  expect(headers['x-money-coach-provider']).toBe('gemini-direct');
  await expect(answer.locator('[data-conversation-reply]')).toContainText('30,97');
  await expect(answer.locator('[data-conversation-reply]')).toContainText(/elokuu(?:ssa|n|ta)? 2026/iu);
  await answer.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('30,97');
  await expect(page.getByRole('dialog')).toContainText('26.8.2026');
  console.log(JSON.stringify({language:'fi',source:headers['x-money-coach-source'],provider:headers['x-money-coach-provider'],questionToEvidenceMs:Math.round(performance.now()-started),timing:JSON.parse(headers['x-money-coach-usage']??'null')}));
 });

 for(const question of spendingQuestions)test(`native conversation handles "${question}"`,async({page})=>{
  await openCoach(page);const {answer}=await realReply(page,question,2);
  await expect(answer.locator('[data-conversation-reply]')).toContainText('7 017,40');
  await expect(answer.locator('[data-conversation-reply]')).toContainText('September 2026');
  await expect(answer.locator('[data-conversation-reply]')).toContainText(/try|start|review|consider|could|next|focus|look|choose|identify|plan|reduce|track|cut|limit/iu);
 });

 test('ordinary dialogue and follow-up produce model conversation',async({page})=>{
  await openCoach(page);await realReply(page,'What is an impulse purchase?',1);
  const {response}=await realReply(page,'How could I avoid those?');
  const body=response.request().postDataJSON() as ChatBody;
  expect(body.messages.map(message=>message.role)).toEqual(['user','assistant','user']);
  expect(body.messages[1].parts[0].text?.trim()).toBeTruthy();
 });

 test('two-stage taxi composition opens evidence and resolves the previous month',async({page})=>{
  await openCoach(page);const {answer}=await realReply(page,taxiQuestion,2);
  await expect(answer.locator('[data-conversation-reply]')).toContainText('30,97');
  await expect(answer.locator('[data-conversation-reply]')).toContainText('August 2026');
  await answer.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('30,97');
  await expect(page.getByRole('dialog')).toContainText('26.8.2026');
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  const followup=await realReply(page,'What about the month before?',2);
  expect(followup.response.request().postDataJSON().context).toEqual({tool:'showTransactions',input:{period:{start:'2026-08-01',end:'2026-09-01'},category:'taxi'}});
  await expect(followup.answer.locator('[data-conversation-reply]')).toContainText('July 2026');
  await expect(followup.answer.locator('[data-spoken-answer]')).toContainText('226,57');
 });

 test('repeated identical questions make fresh provider calls without replay after reload',async({page})=>{
  await openCoach(page);const ids:string[]=[];
  for(let index=0;index<2;index++){
   const {answer}=await realReply(page,spendingQuestions[0],2);
   ids.push((await answer.getAttribute('data-message-id'))!);
  }
  expect(new Set(ids).size).toBe(2);
  // Freshness is checked using fresh requests and provider call receipts, not text inequality.
  await page.reload();await expect(page.getByRole('textbox',{name:'Your question',exact:true})).toBeEditable();
  await expect(assistants(page)).toHaveCount(0);
  const {answer,response}=await realReply(page,spendingQuestions[0],2);
  expect(ids).not.toContain(await answer.getAttribute('data-message-id'));
  expect(response.request().postDataJSON().messages).toHaveLength(1);
 });

 test('captures the actual conversation at 390 and 1280 pixels',async({page},info)=>{
  await openCoach(page);
  const failures:unknown[]=[];
  for(const question of ['I want healthier money habits. Can we talk about where to start?',spendingQuestions[0],taxiQuestion]){
   try{await realReply(page,question,question===spendingQuestions[0]||question===taxiQuestion?2:undefined);}catch(error){failures.push(error);}
  }
  for(const width of [390,1280]){
   await page.setViewportSize({width,height:900});
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`real-conversation-${width}.png`),fullPage:true,animations:'disabled'});
  }
  if(failures.length)throw new AggregateError(failures,'Real conversation failures; screenshots preserve the observed UI');
  await expect(page.locator('[data-conversation-reply]')).toHaveCount(3);
 });
});
