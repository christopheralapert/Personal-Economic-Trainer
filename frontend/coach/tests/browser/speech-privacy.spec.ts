import {test,expect} from "@playwright/test";
import {fi} from "../../src/i18n/dictionaries";
import path from "node:path";

async function setup(page:import("@playwright/test").Page,scenario:"available"|"denied"|"missing"|"unsupported"|"remote"|"long") {
 await page.addInitScript((kind)=>{
  localStorage.setItem("money-coach-privacy.v1","true");localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:"fi",savings:10,savingsSource:"user"}));
  const state={starts:0,spoken:"",local:false,language:"",cancelled:false};(window as unknown as {speechTest:typeof state}).speechTest=state;
  class FakeRecognition {
   static async available(){return kind==='missing' ? 'unavailable' : 'available';}
   lang='';interimResults=false;processLocally=false;onresult:((value:unknown)=>void)|null=null;onerror:((value:unknown)=>void)|null=null;onend:(()=>void)|null=null;
   start(){state.starts++;state.local=this.processLocally;state.language=this.lang;if(kind==='long')return;setTimeout(()=>{if(kind==='denied')this.onerror?.({error:'not-allowed'});else this.onresult?.({resultIndex:0,results:[[{transcript:'Paljonko käytin takseihin viime kuus'}]]});this.onend?.();},0);}
   stop(){this.onend?.();} abort(){state.cancelled=true;this.onend?.();}
  }
  Object.defineProperty(window,'SpeechRecognition',{value:kind==='unsupported' ? undefined : FakeRecognition,configurable:true});
  Object.defineProperty(window,'webkitSpeechRecognition',{value:undefined,configurable:true});
  const voices=[{lang:'fi-FI',localService:kind!=='remote',name:'Finnish voice'}];
  Object.defineProperty(window,'SpeechSynthesisUtterance',{configurable:true,value:class {text:string;lang='';voice:unknown;onend:unknown;onerror:unknown;constructor(text:string){this.text=text;}}});
  Object.defineProperty(window,'speechSynthesis',{configurable:true,value:{getVoices:()=>voices,addEventListener:()=>{},removeEventListener:()=>{},speak:(utterance:SpeechSynthesisUtterance)=>{state.spoken=utterance.text;},cancel:()=>{state.cancelled=true;}}});
 },scenario);
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:'reduce'});
 const metadata=test.info().config.metadata,response=await page.goto(`${metadata.demoPath??'/'}?dataset=organizer1`);
 if(metadata.publicBuild){expect(response?.status()).toBe(200);expect(response?.headers()['x-moneylens-build']).toBe(metadata.publicBuild);}
 await expect(page.locator('header')).toContainText('30.9.2026');await page.getByRole('tab',{name:fi.coach,exact:true}).click();
}

test('private Finnish voice draft stays editable and opens grounded transaction evidence',async({page})=>{
 const external:string[]=[];page.on('request',request=>{if(/generativelanguage|openai\.com/.test(request.url()))external.push(request.url());});
 await setup(page,'available');await page.getByRole('button',{name:fi.speechStart,exact:true}).click();
 const input=page.getByRole('textbox',{name:fi.questionLabel,exact:true});await expect(input).toHaveValue('Paljonko käytin takseihin viime kuus');
 await input.fill('Paljonko käytin takseihin viime kuussa?');const responsePromise=page.waitForResponse(response=>response.url().endsWith('/api/chat'));
 await page.getByRole('button',{name:fi.send,exact:true}).click();const response=await responsePromise;expect(response.headers()['x-money-coach-source']).toBe('rule');expect(response.headers()['x-money-coach-evaluation']).toBe('privacy_rule');expect(response.headers()['x-money-coach-provider']).toBeUndefined();expect(response.request().postDataJSON().privacy).toBe(true);
 const answer=page.locator('[data-message-role="assistant"]').last();await expect(page.locator('[data-message-role="user"]').last()).toContainText('Paljonko käytin takseihin viime kuussa?');await expect(answer).toContainText('Käytit takseihin elokuussa 2026 yhteensä 30,97');await expect(answer).toContainText(fi.modeRules);
 await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/privacy-voice.png')});
 await answer.getByRole('button',{name:fi.readAloud,exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as unknown as {speechTest:{spoken:string}}).speechTest.spoken)).toContain('Käytit takseihin elokuussa 2026 yhteensä 30,97');
 await answer.getByRole('button',{name:fi.stopReading,exact:true}).click();await answer.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();const sheet=page.getByRole('dialog',{name:'Tapahtuman tiedot'});await expect(sheet).toContainText('30,97');await expect(sheet).toContainText('26.8.2026');await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/privacy-transaction.png'),animations:'disabled'});
 expect(await page.evaluate(()=>(window as unknown as {speechTest:{starts:number;local:boolean;language:string}}).speechTest)).toMatchObject({starts:1,local:true,language:'fi-FI'});expect(external).toEqual([]);
});

for(const scenario of ['denied','missing','unsupported'] as const) test(`private speech ${scenario} leaves text input available`,async({page})=>{
 await setup(page,scenario);await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByRole('status').filter({hasText:scenario==='denied' ? fi.speechDenied : scenario==='unsupported' ? fi.speechUnavailable : fi.speechLocalUnavailable}).first()).toBeVisible();
 const input=page.getByRole('textbox',{name:fi.questionLabel,exact:true});await expect(input).toBeEditable();await input.fill('Paljonko käytin takseihin viime kuussa?');expect((await input.boundingBox())?.width).toBeGreaterThan(150);
 if(scenario==='missing' || scenario==='unsupported')expect(await page.evaluate(()=>(window as unknown as {speechTest:{starts:number}}).speechTest.starts)).toBe(0);
 await page.getByRole('button',{name:fi.send,exact:true}).click();await expect(page.locator('[data-message-role="assistant"]').last()).toContainText('Käytit takseihin elokuussa 2026 yhteensä 30,97');
 await page.screenshot({path:path.resolve(__dirname,`../../../../.impeccable/review/privacy-${scenario}.png`),animations:'disabled'});
});

test('listening can be stopped or cancelled and a remote-only voice is not offered privately',async({page})=>{
 await setup(page,'long');await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.speechListening).first()).toHaveCount(1);await page.getByRole('button',{name:fi.speechCancel,exact:true}).click();await expect(page.getByRole('button',{name:fi.speechStart,exact:true})).toBeVisible();
 await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await page.getByRole('button',{name:fi.speechStop,exact:true}).click();await expect(page.getByRole('button',{name:fi.speechStart,exact:true})).toBeVisible();
});

test('privacy mode does not use a remote-only read-aloud voice',async({page})=>{
 await setup(page,'remote');const input=page.getByRole('textbox',{name:fi.questionLabel,exact:true});await input.fill('Paljonko käytin takseihin viime kuussa?');await page.getByRole('button',{name:fi.send,exact:true}).click();
 const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer.getByRole('button',{name:fi.readAloud,exact:true})).toBeDisabled();await expect(answer).toContainText(fi.voiceUnavailable);expect(await page.evaluate(()=>(window as unknown as {speechTest:{spoken:string}}).speechTest.spoken)).toBe('');
});

test('settings switches privacy and shows the online speech disclosure',async({page})=>{
 await setup(page,'available');await page.getByRole('button',{name:fi.settings,exact:true}).click();
 const privacy=page.getByRole('switch',{name:new RegExp(fi.privacyMode)});await expect(privacy).toBeChecked();await privacy.uncheck();
 await page.getByRole('button',{name:fi.back,exact:true}).click();await expect(page.getByText(fi.speechOnline)).toBeVisible();
 await page.getByRole('button',{name:fi.settings,exact:true}).click();await privacy.check();await page.getByRole('button',{name:fi.back,exact:true}).click();await expect(page.getByText(fi.speechOnline)).toHaveCount(0);
});

async function cloudVoice(page:import('@playwright/test').Page,denied=false){
 // Mocked speech checks must never incur a real financial model call.
 await page.route("**/api/chat",async route=>{const body=route.request().postDataJSON();const response=await route.fetch({postData:{...body,privacy:true}});await route.fulfill({response});});
 await page.route('**/api/voice/capabilities',route=>route.fulfill({json:{enabled:true},headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}}));
 await page.addInitScript((deny)=>{
  const state={stopped:0,plays:0,pauses:0};(window as unknown as {cloudSpeech:typeof state}).cloudSpeech=state;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{if(deny)throw new DOMException('Denied','NotAllowedError');return {getTracks:()=>[{stop:()=>state.stopped++}]};}}});
  class Recorder {static isTypeSupported(type:string){return type==='audio/webm;codecs=opus';}state='inactive';ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:(()=>void)|null=null;start(){this.state='recording';}stop(){this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob(['synthetic microphone audio'])});this.onstop?.();},0);}}
  Object.defineProperty(window,'MediaRecorder',{configurable:true,value:Recorder});
  Object.defineProperty(window,'Audio',{configurable:true,value:class {addEventListener(){}async play(){state.plays++;}pause(){state.pauses++;}}});
 },denied);
 await setup(page,'available');await page.getByRole('button',{name:fi.settings,exact:true}).click();await page.getByRole('switch',{name:new RegExp(fi.privacyMode)}).uncheck();await page.getByRole('button',{name:new RegExp(`^${fi.voiceSettings}`)}).click();await page.getByRole('radio',{name:fi.geminiVoice,exact:true}).check();await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/gemini-voice-settings.png'),animations:'disabled'});await page.keyboard.press('Escape');await page.getByRole('button',{name:fi.back,exact:true}).click();await expect(page.getByText(fi.geminiVoiceNotice).or(page.getByText(fi.geminiCoachVoiceNotice))).toBeVisible();
}

test('Gemini recording is editable before sending and reads the same grounded Finnish answer',async({page})=>{
 let transcripts=0,speech=0;await page.route('**/api/voice/transcribe',async route=>{transcripts++;expect(route.request().headers()['x-money-coach-privacy']).toBe('off');expect(route.request().headers()['x-money-coach-language']).toBe('fi');await route.fulfill({json:{text:'Paljonko käytin takseihin viime kuus'},headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}});});
 await page.route('**/api/voice/speak',async route=>{speech++;expect(route.request().postDataJSON()).toMatchObject({dataset:'organizer1',locale:'fi',tool:'showTransactions',input:{category:'taxi',period:{start:'2026-08-01',end:'2026-09-01'}}});expect(route.request().postDataJSON()).not.toHaveProperty('text');await route.fulfill({body:Buffer.from('synthetic WAV'),contentType:'audio/wav',headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}});});
 await cloudVoice(page);await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.geminiRecording)).toBeVisible();expect(transcripts).toBe(0);await page.getByRole('button',{name:fi.speechStop,exact:true}).click();
 const input=page.getByRole('textbox',{name:fi.questionLabel,exact:true});await expect(input).toHaveValue('Paljonko käytin takseihin viime kuus');await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);await input.fill('Paljonko käytin takseihin viime kuussa?');await page.getByRole('button',{name:fi.send,exact:true}).click();
 const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer).toContainText('Käytit takseihin elokuussa 2026 yhteensä 30,97');await answer.getByRole('button',{name:fi.readAloud,exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as unknown as {cloudSpeech:{plays:number}}).cloudSpeech.plays)).toBe(1);expect(speech).toBe(1);
 // Starting the microphone stops playback; cancellation sends no recording.
 const paused=await page.evaluate(()=>(window as unknown as {cloudSpeech:{pauses:number}}).cloudSpeech.pauses);await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.geminiRecording)).toBeVisible();await expect.poll(()=>page.evaluate(()=>(window as unknown as {cloudSpeech:{pauses:number}}).cloudSpeech.pauses)).toBeGreaterThan(paused);await page.getByRole('button',{name:fi.speechCancel,exact:true}).click();expect(transcripts).toBe(1);await expect(input).toHaveValue('');await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
 for(const colorScheme of ['light','dark'] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:path.resolve(__dirname,`../../../../.impeccable/review/gemini-voice-answer-${colorScheme}.png`),animations:'disabled'});}await page.emulateMedia({colorScheme:'light'});
 await page.setViewportSize({width:1440,height:900});await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/gemini-voice-desktop.png'),animations:'disabled'});await page.setViewportSize({width:390,height:844});
 await answer.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();await expect(page.getByRole('dialog',{name:'Tapahtuman tiedot'})).toContainText('26.8.2026');
 await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/gemini-voice-fi.png'),animations:'disabled'});
});

test('Privacy mode overrides a stored Gemini choice and never uploads speech',async({page})=>{
 let uploads=0;await page.route('**/api/voice/transcribe',route=>{uploads++;return route.abort();});await page.route('**/api/voice/speak',route=>{uploads++;return route.abort();});
 await page.addInitScript(()=>localStorage.setItem('money-coach-voice-provider.v1','gemini'));await setup(page,'missing');await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.speechLocalUnavailable)).toBeVisible();await page.getByRole('textbox',{name:fi.questionLabel,exact:true}).fill('Paljonko käytin takseihin viime kuussa?');await page.getByRole('button',{name:fi.send,exact:true}).click();await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(fi.modeRules);expect(uploads).toBe(0);
});

test('Gemini microphone denial leaves typing available without upload',async({page})=>{
 let uploads=0;await page.route('**/api/voice/transcribe',route=>{uploads++;return route.abort();});await cloudVoice(page,true);await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.speechDenied)).toBeVisible();await expect(page.getByRole('textbox',{name:fi.questionLabel,exact:true})).toBeEditable();expect(uploads).toBe(0);
});

test('Gemini rate limit is shown once without automatic retry',async({page})=>{
 let uploads=0;await page.route('**/api/voice/transcribe',route=>{uploads++;return route.fulfill({status:429,json:{error:'provider_wait'},headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}});});await cloudVoice(page);await page.getByRole('button',{name:fi.speechStart,exact:true}).click();await expect(page.getByText(fi.geminiRecording)).toBeVisible();await page.getByRole('button',{name:fi.speechStop,exact:true}).click();await expect(page.getByText(fi.geminiVoiceWait)).toBeVisible();await expect(page.getByRole('textbox',{name:fi.questionLabel,exact:true})).toBeEditable();expect(uploads).toBe(1);
});

test('device read-aloud uses the financial summary rather than answer attribution',async({page})=>{
 await setup(page,'available');
 await page.getByRole('textbox',{name:fi.questionLabel,exact:true}).fill('Where did my money go last month?');
 await page.getByRole('button',{name:fi.send,exact:true}).click();
 const answer=page.locator('[data-message-role="assistant"]').last(),sentence=answer.locator('[data-spoken-answer]').first();
 await expect(sentence).toContainText('2026');
 const text=await sentence.textContent();expect(text).toMatch(/\d+[,.]\d{2}/);expect(text).not.toContain(fi.modeRules);
 await answer.getByRole('button',{name:fi.readAloud,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {speechTest:{spoken:string}}).speechTest.spoken)).toBe(text);
 await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/import-update/mobile-category-speech.png'),animations:'disabled'});
});

test('hosted read-aloud follows changed scenario selectors and discards cached audio',async({page})=>{
 const requests:Array<{tool:string;input:{pct:number}}>=[];
 await page.route('**/api/voice/speak',route=>{
  requests.push(route.request().postDataJSON());
  return route.fulfill({body:Buffer.from('synthetic WAV'),contentType:'audio/wav',headers:{'x-money-coach-revision':route.request().headers()['x-money-coach-revision']}});
 });
 await cloudVoice(page);
 await page.getByRole('textbox',{name:fi.questionLabel,exact:true}).fill('What if I cut taxis by 20% last month?');
 await page.getByRole('button',{name:fi.send,exact:true}).click();
 const answer=page.locator('[data-message-role="assistant"]').last(),slider=answer.getByRole('slider');
 await expect(slider).toHaveAttribute('aria-valuenow','20');
 await answer.getByRole('button',{name:fi.readAloud,exact:true}).click();await expect.poll(()=>requests.length).toBe(1);
 await slider.focus();await slider.press('Home');for(let i=0;i<5;i++)await slider.press('PageUp');
 await expect(slider).toHaveAttribute('aria-valuenow','50');await expect(answer.locator('[data-spoken-answer]')).toContainText('15,49');
 await answer.getByRole('button',{name:fi.readAloud,exact:true}).click();await expect.poll(()=>requests.length).toBe(2);
 expect(requests.map(value=>value.input.pct)).toEqual([20,50]);expect(requests.every(value=>value.tool==='showWhatIf')).toBe(true);
 await page.screenshot({path:path.resolve(__dirname,'../../../../.impeccable/review/import-update/mobile-scenario-current.png'),animations:'disabled'});
});
