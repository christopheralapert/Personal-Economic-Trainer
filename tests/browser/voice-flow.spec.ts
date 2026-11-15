import {test,expect} from '@playwright/test';
import {setupVoice,mockHostedVoice,questionInput,submitQuestion,languages} from './voice-support';
const assistant=(page:import('@playwright/test').Page)=>page.locator('[data-message-role="assistant"]').last();
test('typed thanks is an immediate acknowledgement; arrow and Enter share the real composer',async({page})=>{
 const traffic=await setupVoice(page,'en','available',{privacy:false,provider:'gemini'});await mockHostedVoice(page,'en');
 await questionInput(page,'en').fill('Thank you');await page.getByRole('button',{name:'Send question',exact:true}).click();await expect(assistant(page)).toContainText('You’re welcome!');expect(traffic.chat).toHaveLength(0);
 await questionInput(page,'en').fill('Thanks');await questionInput(page,'en').press('Enter');await expect(page.locator('[data-message-role="user"]')).toHaveCount(2);expect(traffic.chat).toHaveLength(0);
 await submitQuestion(page,'en');expect(traffic.chat).toHaveLength(1);await expect(assistant(page)).toContainText('30,97');
});
test('loading is immediate, Stop cancels pending audio, every Listen makes a fresh request',async({page})=>{
 await setupVoice(page,'en','available',{privacy:false,provider:'gemini'});await mockHostedVoice(page,'en');const {answer}=await submitQuestion(page,'en');
 let release!:()=>void;const gate=new Promise<void>(r=>release=r);let calls=0;
 await page.route('**/api/voice/speak',async route=>{calls++;if(calls===1)await gate;await route.fulfill({body:'synthetic WAV',headers:{'content-type':'audio/wav','x-money-coach-revision':route.request().headers()['x-money-coach-revision']}}).catch(()=>{});});
 await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();await expect(answer.getByText('Preparing audio…',{exact:true})).toBeVisible();await answer.getByRole('button',{name:'Stop',exact:true}).click();release();await expect(answer.getByText('Preparing audio…',{exact:true})).toHaveCount(0);expect(await page.evaluate(()=>window.voiceTest.plays)).toBe(0);
 await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(1);await answer.getByRole('button',{name:'Stop',exact:true}).click();await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(2);expect(calls).toBe(3);
});
test('empty hosted transcript preserves draft and lets the next recording succeed',async({page})=>{
 await setupVoice(page,'en','available',{privacy:false,provider:'gemini'});await mockHostedVoice(page,'en');let count=0;
 await page.route('**/api/voice/transcribe',route=>route.fulfill({json:{text:count++?'Thank you':''},headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}}));
 await questionInput(page,'en').fill('My editable draft');
 for(let i=0;i<2;i++){await page.getByRole('button',{name:'Voice input',exact:true}).click();await page.getByRole('button',{name:'Stop',exact:true}).click();await expect(page.getByRole('button',{name:'Voice input',exact:true})).toBeVisible();}
 await expect(questionInput(page,'en')).toHaveValue('My editable draft');await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
});
for(const [language,thanks] of [['en','thank you'],['fi','kiitos'],['et','tänan'],['es','gracias'],['ja','ありがとう']] as const)test(`${language}: separate dictated thanks sends once, middle thanks remains editable`,async({page})=>{
 const traffic=await setupVoice(page,'en');
 if(language!=='en'){await questionInput(page,'en').fill(`Reply from now on in ${({fi:'Finnish',et:'Estonian',es:'Spanish',ja:'Japanese'} as const)[language]}`);await questionInput(page,'en').press('Enter');}
 await page.getByRole('button',{name:'Voice input',exact:true}).click();await page.evaluate(text=>{window.voiceTest.result(text);window.voiceTest.end();},`${thanks}, show my spending`);await expect(questionInput(page,'en')).toHaveValue(`${thanks}, show my spending`);
 await page.getByRole('button',{name:'Voice input',exact:true}).click();await page.evaluate(text=>{window.voiceTest.result(text);window.voiceTest.end();},`How much did I spend on taxis last month? ${thanks}`);
 await expect(page.locator('[data-message-role="user"]').last()).toContainText('How much did I spend on taxis last month');await expect(questionInput(page,'en')).toHaveValue('');
 expect(traffic.chat.length).toBe(language==='es'||language==='ja'?0:1);expect(traffic.audio).toHaveLength(0);
});
test('language commands preserve the current conversation but reload never restores cached answers',async({page})=>{
 await setupVoice(page,'en');await submitQuestion(page,'en');
 for(const command of ['Vasta sellele hispaania keeles','Vasta edaspidi jaapani keeles','Switch the whole app back to English']){await questionInput(page,'en').fill(command);await questionInput(page,'en').press('Enter');}
 await expect(page.locator('[data-message-role="user"]')).toHaveCount(4);await expect(page.locator('[data-message-role="assistant"]').first()).toContainText('30,97');
 await page.reload();await page.getByRole('tab',{name:'Coach',exact:true}).click();await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('money-coach-thread.')))).toEqual([]);
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('radio',{name:'English',exact:true})).toBeChecked();
});
test('fresh dining scenario and next audio use the same percentage and baseline',async({page})=>{
 await setupVoice(page,'en','available',{privacy:false,provider:'gemini'});const hosted=await mockHostedVoice(page,'en');
 await questionInput(page,'en').fill('What if I cut dining out by 20%?');await questionInput(page,'en').press('Enter');const answer=assistant(page),slider=answer.getByRole('slider');await expect(slider).toHaveAttribute('aria-valuenow','20');await expect(answer).toContainText('159,58');await expect(answer).toContainText('797,88');
 await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();await expect.poll(()=>hosted.speeches.length).toBe(1);expect(hosted.speeches[0].input).toMatchObject({pct:20});
 await slider.focus();await slider.press('Home');for(let i=0;i<30;i++)await slider.press('ArrowRight');await expect(slider).toHaveAttribute('aria-valuenow','30');await expect(answer.locator('[data-spoken-answer]')).toContainText('239,36');await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();await expect.poll(()=>hosted.speeches.length).toBe(2);expect(hosted.speeches[1].input).toMatchObject({pct:30});
});
test('Privacy mid-conversation blocks hosted chat/audio and keeps evidence usable',async({page})=>{
 const traffic=await setupVoice(page,'en','available',{privacy:false,provider:'gemini'});const hosted=await mockHostedVoice(page,'en');await submitQuestion(page,'en');
 await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('switch',{name:'Privacy mode',exact:true}).check();await page.getByRole('button',{name:'Back',exact:true}).click();
 await submitQuestion(page,'en');await assistant(page).getByRole('button',{name:'Listen to answer',exact:true}).click();await page.getByRole('button',{name:'Voice input',exact:true}).click();await page.evaluate(()=>{window.voiceTest.result('Thank you');window.voiceTest.end();});expect(hosted.transcriptions).toHaveLength(0);expect(hosted.speeches).toHaveLength(0);expect(traffic.audio).toHaveLength(0);expect(traffic.chat.at(-1)).toMatchObject({privacy:true});await expect(assistant(page)).toContainText('30,97');
});
test('reviewed UI languages preserve evidence and unsupported choices never request AI translation',async({page})=>{
 const traffic=await setupVoice(page,'en','available',{privacy:false});await mockHostedVoice(page,'en');await submitQuestion(page,'en');
 const translations:string[]=[];page.on('request',request=>{if(new URL(request.url()).pathname==='/api/language')translations.push(request.url());});
 for(const name of ['Spanish','Japanese']){
  await questionInput(page,'en').fill(`Switch the whole app to ${name}`);await questionInput(page,'en').press('Enter');
  await expect(page.locator('div[lang="en"]')).toBeVisible();await expect(assistant(page)).toContainText('The interface supports English, Finnish and Estonian.');
 }
 await expect(page.locator('[data-message-role="assistant"]').first()).toContainText('30,97');
 await page.locator('[data-message-role="assistant"]').first().getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('30,97');await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.getByRole('radiogroup',{name:'Language',exact:true}).getByRole('radio')).toHaveCount(3);
 for(const code of ['fi','et','en'] as const){
  await page.locator(`#language-${code}`).click();await expect(page.getByRole('heading',{name:languages[code].copy.settings,exact:true})).toBeVisible();
  await expect(page.locator(`div[lang="${code}"]`)).toBeVisible();
 }
 await page.getByRole('button',{name:'Back',exact:true}).click();
 await expect(page.locator('[data-message-role="assistant"]').first()).toContainText('30,97');
 await page.reload();await page.getByRole('button',{name:'Settings',exact:true}).click();await expect(page.locator('#language-en')).toBeChecked();
 expect(translations).toEqual([]);expect(traffic.chat).toHaveLength(1);
 expect((await page.request.post('/api/language',{data:{language:'es',keys:['coach']}})).status()).toBe(404);
});
test('dictation end and simultaneous form submission send a financial question exactly once',async({page})=>{
 const traffic=await setupVoice(page,'en');const question='How much did I spend on taxis last month?';await questionInput(page,'en').fill(question);await page.getByRole('button',{name:'Voice input',exact:true}).click();
 await page.evaluate(q=>{window.voiceTest.result(`${q} Thank you`);window.voiceTest.end();document.querySelector('form')!.requestSubmit();},question);
 await expect(assistant(page)).toContainText('30,97');await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);expect(traffic.chat).toHaveLength(1);
});
test('Privacy keeps UI language commands local and conversation language independent',async({page})=>{
 const traffic=await setupVoice(page,'en'),translations:string[]=[];
 page.on('request',request=>{if(new URL(request.url()).pathname==='/api/language')translations.push(request.url());});
 for(const command of ['Reply from now on in Spanish','Switch the whole app to Japanese']){await questionInput(page,'en').fill(command);await questionInput(page,'en').press('Enter');}
 await expect(page.locator('div[lang="en"]')).toBeVisible();await expect(page.locator('[data-message-role="assistant"]').first()).toContainText('Responderé en español.');
 await questionInput(page,'en').fill('How much did I spend on taxis last month?');await questionInput(page,'en').press('Enter');await expect(assistant(page)).toContainText('Local Coach supports English, Finnish and Estonian.');
 await questionInput(page,'en').fill('Switch the whole app back to English');await questionInput(page,'en').press('Enter');
 await submitQuestion(page,'en');await expect(assistant(page)).toContainText('30,97');
 expect(translations).toEqual([]);expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);expect(traffic.chat).toHaveLength(1);expect(traffic.chat[0]).toMatchObject({privacy:true});
});
