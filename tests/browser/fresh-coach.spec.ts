import {test,expect} from '@playwright/test';
// Live text, repeat requests and reload checks live in conversational-coach.spec.ts.
test('real Gemini speech is generated on an explicit Listen request',async({page})=>{
 test.skip(process.env.MONEY_COACH_REAL_FRESH_TEST!=='true','Explicit real synthetic provider opt-in required');
 await page.addInitScript(()=>{
  const timings:unknown[]=[];
  Object.assign(window,{moneyCoachAudioTimings:timings});
  window.addEventListener('money-coach-audio-timing',event=>timings.push((event as CustomEvent).detail));
 });
 await page.addInitScript(()=>{localStorage.setItem('money-coach-privacy.v1','false');localStorage.setItem('money-coach-voice-provider.v1','gemini');});await page.goto('/demo?dataset=organizer1&tab=coach');await page.getByRole('textbox',{name:'Your question',exact:true}).fill('How much did I spend on taxis last month?');await page.getByRole('button',{name:'Send question',exact:true}).click();const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer.locator('[data-spoken-answer]')).toContainText('30,97');
 const audio=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/voice/speak');await answer.getByRole('button',{name:'Listen to answer',exact:true}).click();const speech=await audio;expect(speech.status(),speech.ok()?'':String((await speech.json()).error)).toBe(200);expect(speech.headers()['x-money-coach-voice-provider']).toBe('gemini');const content=await speech.body();expect(content.length).toBeGreaterThan(100);if(speech.headers()['content-type']==='application/x-money-coach-pcm'){expect(content.toString()).toContain('"type":"audio"');expect(content.toString()).toContain('"type":"done"');expect(content.toString()).not.toContain('"type":"error"');}
 await expect.poll(()=>page.evaluate(()=>(window as unknown as {moneyCoachAudioTimings:unknown[]}).moneyCoachAudioTimings.length)).toBe(1);
 const timing=await page.evaluate(()=>(window as unknown as {moneyCoachAudioTimings:unknown[]}).moneyCoachAudioTimings[0]);
 console.log(JSON.stringify({realGeminiSpeechRequests:1,audioBytes:content.length,timing,physicalSpeakerVerified:false}));
});
test('real NVIDIA UI translation is generated again for identical requests',async({page})=>{
 test.skip(process.env.MONEY_COACH_REAL_FRESH_TEST!=='true','Explicit real synthetic provider opt-in required');
 const response=await page.goto('/demo'),revision=response!.headers()['x-moneylens-build'];
 for(let index=0;index<2;index++){const result=await page.evaluate(async revision=>{const response=await fetch('/api/language',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json','X-Money-Coach-Privacy':'off','X-Money-Coach-Revision':revision},body:JSON.stringify({language:'es',keys:['coach','learn']})});return {status:response.status,body:await response.json()};},revision);expect(result.status,String(result.body.error??'')).toBe(200);expect(result.body).toMatchObject({provider:'nemotron',cached:false});expect(Object.keys(result.body.translations)).toEqual(['coach','learn']);}
 console.log(JSON.stringify({realNemotronUITranslationRequests:2,reusedResults:false}));
});
