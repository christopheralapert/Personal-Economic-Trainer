import {test,expect} from "@playwright/test";
import path from "node:path";
import {languages,setupVoice,questionInput,submitQuestion,mockHostedVoice,type Locale} from "./voice-support";

for(const locale of Object.keys(languages) as Locale[])for(const provider of ["browser","gemini"] as const)for(const width of [360,390])for(const colorScheme of ["light","dark"] as const){
 test(`phone ${locale} ${provider} ${width} ${colorScheme}: visible controls and restart`,async({page})=>{
  const {copy,draft}=languages[locale];
  await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme});
  await setupVoice(page,locale,"available",{privacy:provider==="browser",provider});
  if(provider==="gemini"){
   await mockHostedVoice(page,locale);
   const disclosure=page.getByText(copy.geminiVoiceNotice,{exact:true}).or(page.getByText(copy.geminiCoachVoiceNotice,{exact:true}));
   await expect(disclosure).toHaveCount(1);await expect(disclosure).toBeVisible();
   expect(await page.evaluate(()=>window.voiceTest.media)).toBe(0);
  }
  const input=questionInput(page,locale),mic=page.getByRole("button",{name:copy.speechStart,exact:true});
  const inputBox=(await input.boundingBox())!,micBox=(await mic.boundingBox())!;
  expect(micBox.x).toBeGreaterThanOrEqual(inputBox.x+inputBox.width);
  expect(Math.abs(micBox.y-inputBox.y)).toBeLessThan(5);
  await mic.click();
  const stop=page.getByRole("button",{name:copy.speechStop,exact:true}),cancel=page.getByRole("button",{name:copy.speechCancel,exact:true});
  await expect(stop).toBeVisible();await expect(cancel).toBeVisible();
  const prefix=path.resolve(".cache/voice-review",`${locale}-${provider}-${width}-${colorScheme}`);
  await page.screenshot({path:`${prefix}-listening.png`,animations:"disabled"});
  await expect(stop).toHaveText(copy.speechStop);await expect(cancel).toHaveText(copy.speechCancel);
  for(const button of [stop,cancel]){
   const box=(await button.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(48);expect(box.width).toBeGreaterThanOrEqual(48);
  }
  if(provider==="browser")await page.evaluate(text=>window.voiceTest.result(text),draft);
  await stop.click();await expect(input).toHaveValue(draft);await expect(input).toBeEditable();
  const {answer}=await submitQuestion(page,locale);
  await expect(page.getByText(copy.geminiTranscriptReady,{exact:true})).toHaveCount(0);
  const listen=answer.getByRole("button",{name:copy.readAloud,exact:true});await expect(listen).toHaveCount(1);await listen.click();
  const pause=answer.getByRole("button",{name:copy.stopReading,exact:true});await expect(pause).toBeVisible();
  // Bring the answer's playback button above the fixed composer before capture.
  await pause.scrollIntoViewIfNeeded();
  await page.screenshot({path:`${prefix}-playing.png`,animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);
  await pause.click();await listen.click();await expect(pause).toBeVisible();
  if(provider==="browser")await expect.poll(()=>page.evaluate(()=>window.voiceTest.spoken.length)).toBe(2);
  else await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(2);
 });
}

for(const locale of Object.keys(languages) as Locale[])for(const provider of ["browser","gemini"] as const){
 test(`${locale} ${provider}: reading follows the edited answer and invalidates old audio`,async({page})=>{
  const {copy}=languages[locale];await setupVoice(page,locale,"available",{privacy:provider==="browser",provider});
  const hosted=provider==="gemini" ? await mockHostedVoice(page,locale) : null;
  await questionInput(page,locale).fill("What if I cut taxis by 20% last month?");
  await page.getByRole("button",{name:copy.send,exact:true}).click();
  const answer=page.locator('[data-message-role="assistant"]').last(),slider=answer.getByRole("slider"),sentence=answer.locator("[data-spoken-answer]");
  await expect(slider).toHaveAttribute("aria-valuenow","20");
  await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays+window.voiceTest.spoken.length)).toBe(1);
  const original=(await sentence.textContent())!.trim();
  await slider.focus();await slider.press("Home");for(let i=0;i<5;i++)await slider.press("PageUp");
  await expect(slider).toHaveAttribute("aria-valuenow","50");await expect(sentence).toContainText("15,49");
  const visible=(await sentence.textContent())!.trim();expect(visible).not.toBe(original);
  await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays+window.voiceTest.spoken.length)).toBe(2);
  if(hosted){
   expect(hosted.speeches.map(value=>(value.input as {pct:number}).pct)).toEqual([20,50]);
   expect(hosted.speeches.every(value=>value.tool==="showWhatIf")).toBe(true);
   await page.evaluate(()=>{window.voiceTest.settleHosted(0);window.voiceTest.settleHosted(0,true);});
  }else{
   expect(await page.evaluate(()=>window.voiceTest.spoken.map(value=>value.text))).toEqual([original,visible]);
   await page.evaluate(()=>{window.voiceTest.settleSpeech(0);window.voiceTest.settleSpeech(0,true);});
  }
  await expect(answer.getByRole("button",{name:copy.stopReading,exact:true})).toBeVisible();
 });
}

test("desktop keeps the same compact voice composer",async({page})=>{
 const {copy}=languages.et;await page.setViewportSize({width:1440,height:900});await setupVoice(page,"et");
 const mic=page.getByRole("button",{name:copy.speechStart,exact:true});await mic.click();
 await expect(page.getByRole("button",{name:copy.speechStop,exact:true})).toHaveText(copy.speechStop);
 await page.screenshot({path:path.resolve(".cache/voice-review/desktop-listening.png"),animations:"disabled"});
});

test("typing cancels a pending on-device language check",async({page})=>{
 const {copy}=languages.et;await setupVoice(page,"et");
 await page.evaluate(()=>{
  const {SpeechRecognition:Recognition}=window as unknown as {SpeechRecognition:{available:()=>Promise<string>}};
  Recognition.available=()=>new Promise(resolve=>window.addEventListener("voice-test-local-ready",()=>resolve("available"),{once:true}));
 });
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect(page.getByRole("button",{name:copy.speechCancel,exact:true})).toBeVisible();
 await questionInput(page,"et").fill("Keep my draft");
 await page.evaluate(()=>window.dispatchEvent(new Event("voice-test-local-ready")));
 await expect(page.getByRole("button",{name:copy.speechStart,exact:true})).toBeVisible();
 await expect(questionInput(page,"et")).toHaveValue("Keep my draft");
 expect(await page.evaluate(()=>window.voiceTest.recognitions)).toEqual([]);
});

for(const locale of Object.keys(languages) as Locale[]){
 const {copy,tag,draft,question}=languages[locale];
 test(`${locale}: private dictation remains editable and reads the visible answer`,async({page})=>{
  const traffic=await setupVoice(page,locale,"available",{provider:"gemini"});
  await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.recognitions)).toEqual([{lang:tag,local:true}]);
  await page.evaluate(text=>{window.voiceTest.result(text);window.voiceTest.end();},draft);
  const input=questionInput(page,locale);await expect(input).toHaveValue(draft);await expect(input).toBeEditable();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);expect(traffic.chat).toHaveLength(0);
  const {answer,response}=await submitQuestion(page,locale);
  expect(response.headers()["x-money-coach-evaluation"]).toBe("privacy_rule");
  expect(response.headers()["x-money-coach-provider"]).toBeUndefined();
  await expect(page.locator('[data-message-role="user"]').last()).toHaveText(question);
  expect(traffic.chat).toEqual([expect.objectContaining({locale,privacy:true,messages:[{role:"user",parts:[{type:"text",text:question}]}]})]);
  const sentence=answer.locator("[data-spoken-answer]").first();
  await expect(sentence).toBeVisible();await expect(sentence).toContainText("30,97");
  const visible=(await sentence.textContent())!.trim();expect(visible).not.toContain(copy.modeRules);
  await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.spoken)).toEqual([{text:visible,lang:tag,local:true}]);
  const cancelled=await page.evaluate(()=>window.voiceTest.cancels);
  await answer.getByRole("button",{name:copy.stopReading,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.cancels)).toBeGreaterThan(cancelled);
  await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>({checks:window.voiceTest.checks,media:window.voiceTest.media}))).toEqual({checks:[{langs:[tag],processLocally:true}],media:0});
  expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
 });

 for(const scenario of ["denied","missing","unsupported","legacy"] as const){
  test(`${locale}: ${scenario} recognition preserves typing without audio upload`,async({page})=>{
   const traffic=await setupVoice(page,locale,scenario,{provider:"gemini"});
   await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
   const status=scenario==="denied" ? copy.speechDenied : scenario==="unsupported" ? copy.speechUnavailable : copy.speechLocalUnavailable;
   await expect(page.getByRole("status").filter({hasText:status})).toBeVisible();
   await expect(questionInput(page,locale)).toBeEditable();
   const {answer}=await submitQuestion(page,locale);await expect(answer.locator("[data-spoken-answer]").first()).toContainText("30,97");
   expect(await page.evaluate(()=>window.voiceTest.recognitions.length)).toBe(scenario==="denied" ? 1 : 0);
   expect(await page.evaluate(()=>window.voiceTest.media)).toBe(0);expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
  });
 }

 test(`${locale}: stop accepts the final draft while cancel discards late results`,async({page})=>{
  const traffic=await setupVoice(page,locale);
  await questionInput(page,locale).fill("Keep this draft");
  await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
  await page.evaluate(text=>window.voiceTest.result(text),draft);
  await expect(questionInput(page,locale)).toHaveValue("Keep this draft");
  await page.getByRole("button",{name:copy.speechCancel,exact:true}).click();
  await page.evaluate(()=>{window.voiceTest.result("Late cancelled result");window.voiceTest.error("not-allowed");window.voiceTest.end();});
  await expect(questionInput(page,locale)).toHaveValue("Keep this draft");
  await expect(page.getByText(copy.speechDenied,{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
  await page.evaluate(text=>window.voiceTest.result(text),draft);
  await page.getByRole("button",{name:copy.speechStop,exact:true}).click();
  await expect(questionInput(page,locale)).toHaveValue(draft);
  await expect(page.getByRole("button",{name:copy.speechStart,exact:true})).toBeVisible();
  expect(await page.evaluate(()=>({aborts:window.voiceTest.aborts,stops:window.voiceTest.stops}))).toEqual({aborts:1,stops:1});
  expect(traffic.chat).toEqual([]);expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
 });

 for(const scenario of ["remote","no-voice"] as const){
  test(`${locale}: ${scenario} synthesis never speaks in privacy mode`,async({page})=>{
   const traffic=await setupVoice(page,locale,scenario,{provider:"gemini"});const {answer}=await submitQuestion(page,locale);
   await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeDisabled();
   await expect(answer.getByRole("status").filter({hasText:copy.voiceUnavailable})).toBeVisible();
   expect(await page.evaluate(()=>({spoken:window.voiceTest.spoken,media:window.voiceTest.media}))).toEqual({spoken:[],media:0});
   expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
  });
 }

 test(`${locale}: mocked hosted dictation is editable and playback follows the visible answer selectors`,async({page})=>{
  const traffic=await setupVoice(page,locale,"available",{privacy:false,provider:"gemini"});
  const hosted=await mockHostedVoice(page,locale);
  await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
  await expect(page.getByText(copy.geminiRecording,{exact:true})).toBeVisible();expect(hosted.transcriptions).toHaveLength(0);
  await page.getByRole("button",{name:copy.speechStop,exact:true}).click();
  await expect(questionInput(page,locale)).toHaveValue(draft);await expect(questionInput(page,locale)).toBeEditable();
  expect(traffic.chat).toHaveLength(0);await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
  const {answer}=await submitQuestion(page,locale);
  await expect(answer.locator("[data-spoken-answer]").first()).toContainText("30,97");
  await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(1);
  expect(hosted.speeches).toEqual([expect.objectContaining({dataset:"organizer1",locale,tool:"showTransactions",input:{category:"taxi",period:{start:"2026-08-01",end:"2026-09-01"}}})]);
  expect(hosted.speeches[0]).not.toHaveProperty("text");
  const pauses=await page.evaluate(()=>window.voiceTest.pauses);
  await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
  await expect(page.getByText(copy.geminiRecording,{exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.pauses)).toBeGreaterThan(pauses);
  await page.getByRole("button",{name:copy.speechCancel,exact:true}).click();
  await expect(page.getByRole("button",{name:copy.speechStart,exact:true})).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>window.voiceTest.tracksStopped)).toBe(2);
  expect(hosted.transcriptions).toHaveLength(1);expect(traffic.chat).toHaveLength(1);expect(traffic.external).toEqual([]);
 });
}

test("recognition language error remains recoverable and reading interrupts listening",async({page})=>{
 const {copy}=languages.fi;await setupVoice(page,"fi");
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await page.evaluate(()=>{window.voiceTest.error("language-not-supported");window.voiceTest.end();});
 await expect(page.getByText(copy.speechLocalUnavailable,{exact:true})).toBeVisible();
 const {answer}=await submitQuestion(page,"fi");
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 const aborts=await page.evaluate(()=>window.voiceTest.aborts);
 await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.aborts)).toBe(aborts+1);
 await page.evaluate(()=>{window.voiceTest.result("Ignored after reading started");window.voiceTest.end();});
 await expect(questionInput(page,"fi")).toHaveValue("");
 await page.evaluate(()=>window.voiceTest.finishSpeech());
 await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeEnabled();
});

for(const locale of Object.keys(languages) as Locale[])test(`${locale}: hosted microphone denial never uploads audio`,async({page})=>{
 const {copy}=languages[locale];const traffic=await setupVoice(page,locale,"denied",{privacy:false,provider:"gemini"});
 const hosted=await mockHostedVoice(page,locale);await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect(page.getByText(copy.speechDenied,{exact:true})).toBeVisible();await expect(questionInput(page,locale)).toBeEditable();
 expect(hosted.transcriptions).toEqual([]);expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
});

for(const locale of Object.keys(languages) as Locale[]){
 test(`${locale}: completed and interrupted recognition cannot overwrite typing or a new capture`,async({page})=>{
  const {copy,draft}=languages[locale];await setupVoice(page,locale);
  const mic=page.getByRole("button",{name:copy.speechStart,exact:true}),input=questionInput(page,locale);
  await mic.click();await page.evaluate(text=>{window.voiceTest.result(text);window.voiceTest.end();},draft);
  await expect(input).toHaveValue(draft);
  await page.evaluate(()=>{window.voiceTest.recognitionResult(0,"Late completed capture");window.voiceTest.recognitionEnd(0);});
  await expect(input).toHaveValue(draft);
  await mic.click();await input.fill("My typed draft");
  await expect(mic).toBeVisible();await expect(input).toHaveValue("My typed draft");
  await mic.click();
  await page.evaluate(()=>{window.voiceTest.recognitionResult(1,"Late interrupted capture");window.voiceTest.recognitionEnd(1);});
  await expect(input).toHaveValue("My typed draft");
  await expect(page.getByRole("button",{name:copy.speechStop,exact:true})).toBeVisible();
  await page.evaluate(text=>{window.voiceTest.result(text);window.voiceTest.end();},draft);
  await expect(input).toHaveValue(draft);await expect(input).toBeEditable();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
 });

 test(`${locale}: typing cancels pending hosted transcription before a fresh recording`,async({page})=>{
  const {copy,draft}=languages[locale];await setupVoice(page,locale,"available",{privacy:false,provider:"gemini"});
  await mockHostedVoice(page,locale);
  let release!:()=>void,delivered!:()=>void,count=0;
  const gate=new Promise<void>(resolve=>{release=resolve;}),late=new Promise<void>(resolve=>{delivered=resolve;});
  await page.route("**/api/voice/transcribe",async route=>{
   const first=++count===1;if(first)await gate;
   await route.fulfill({json:{text:first ? "Old hosted transcript" : draft},headers:{"x-money-coach-revision":route.request().headers()["x-money-coach-revision"]}}).catch(()=>{});
   if(first)delivered();
  });
  const mic=page.getByRole("button",{name:copy.speechStart,exact:true}),stop=page.getByRole("button",{name:copy.speechStop,exact:true}),input=questionInput(page,locale);
  await mic.click();await expect(stop).toBeVisible();
  const requested=page.waitForRequest("**/api/voice/transcribe");await stop.click();await requested;
  await expect(page.getByText(copy.geminiTranscribing,{exact:true})).toBeVisible();
  await input.fill("My edited draft");await expect(mic).toBeVisible();
  await mic.click();await expect(stop).toBeVisible();release();await late;
  await expect(input).toHaveValue("My edited draft");await expect(stop).toBeVisible();
  await stop.click();await expect(input).toHaveValue(draft);await expect(input).toBeEditable();
  await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
  expect(await page.evaluate(()=>window.voiceTest.tracksStopped)).toBe(2);
 });
}

test("cancelling while microphone permission is pending releases the late stream",async({page})=>{
 const {copy}=languages.fi;await setupVoice(page,"fi","available",{privacy:false,provider:"gemini"});
 const hosted=await mockHostedVoice(page,"fi");
 await page.evaluate(()=>{
  const state=window.voiceTest;
  navigator.mediaDevices.getUserMedia=()=>new Promise(resolve=>{
   state.media++;window.addEventListener("voice-test-grant",()=>resolve({getTracks:()=>[{stop:()=>state.tracksStopped++}]} as unknown as MediaStream),{once:true});
  });
 });
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.media)).toBe(1);
 await page.getByRole("button",{name:copy.speechCancel,exact:true}).click();
 await questionInput(page,"fi").fill("Keep my draft");
 await page.evaluate(()=>window.dispatchEvent(new Event("voice-test-grant")));
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.tracksStopped)).toBe(1);
 await expect(questionInput(page,"fi")).toHaveValue("Keep my draft");
 expect(hosted.transcriptions).toEqual([]);expect(await page.evaluate(()=>window.voiceTest.recordings)).toBe(0);
});

test("late events from interrupted speech cannot stop the next playback",async({page})=>{
 const {copy}=languages.fi;await setupVoice(page,"fi");const {answer}=await submitQuestion(page,"fi");
 await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await answer.getByRole("button",{name:copy.stopReading,exact:true}).click();
 await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await page.evaluate(()=>{window.voiceTest.settleSpeech(0);window.voiceTest.settleSpeech(0,true);});
 await expect(answer.getByRole("button",{name:copy.stopReading,exact:true})).toBeVisible();
 await expect(answer.getByText(copy.voiceUnavailable,{exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.voiceTest.settleSpeech(1));
 await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeEnabled();
});

test("enabling privacy interrupts hosted recording and restores local-only recognition",async({page})=>{
 const {copy,tag}=languages.fi;
 const traffic=await setupVoice(page,"fi","available",{privacy:false,provider:"gemini"});
 const hosted=await mockHostedVoice(page,"fi");
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect(page.getByText(copy.geminiRecording,{exact:true})).toBeVisible();
 await page.getByRole("button",{name:copy.settings,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.tracksStopped)).toBe(1);
 await page.getByRole("checkbox",{name:new RegExp(copy.privacyMode)}).check();
 await page.getByRole("button",{name:copy.back,exact:true}).click();
 await expect(page.getByText(copy.geminiVoiceNotice,{exact:true})).toHaveCount(0);
 await expect(page.getByText(copy.geminiCoachVoiceNotice,{exact:true})).toHaveCount(0);
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.recognitions)).toEqual([{lang:tag,local:true}]);
 await page.getByRole("button",{name:copy.speechCancel,exact:true}).click();
 const {answer}=await submitQuestion(page,"fi");await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.spoken.length)).toBe(1);
 expect(hosted.transcriptions).toEqual([]);expect(hosted.speeches).toEqual([]);
 expect(traffic.audio).toEqual([]);expect(traffic.external).toEqual([]);
});

test("cancelling transcription ignores a late response and preserves the edited draft",async({page})=>{
 const {copy}=languages.fi;await setupVoice(page,"fi","available",{privacy:false,provider:"gemini"});
 await mockHostedVoice(page,"fi");
 let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route("**/api/voice/transcribe",async route=>{
  await gate;
  await route.fulfill({json:{text:"Stale transcript"},headers:{"x-money-coach-revision":route.request().headers()["x-money-coach-revision"]}}).catch(()=>{});
 });
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect(page.getByText(copy.geminiRecording,{exact:true})).toBeVisible();
 const requested=page.waitForRequest("**/api/voice/transcribe");
 await page.getByRole("button",{name:copy.speechStop,exact:true}).click();await requested;
 await expect(page.getByText(copy.geminiTranscribing,{exact:true})).toBeVisible();
 await page.getByRole("button",{name:copy.speechCancel,exact:true}).click();
 await questionInput(page,"fi").fill("Keep my edited draft");release();
 // A fresh successful recording proves the cancelled request cannot own the UI.
 await page.unroute("**/api/voice/transcribe");const hosted=await mockHostedVoice(page,"fi");
 await expect(questionInput(page,"fi")).toHaveValue("Keep my edited draft");
 await page.getByRole("button",{name:copy.speechStart,exact:true}).click();
 await expect(page.getByText(copy.geminiRecording,{exact:true})).toBeVisible();
 await page.getByRole("button",{name:copy.speechStop,exact:true}).click();
 await expect(questionInput(page,"fi")).toHaveValue(languages.fi.draft);
 expect(hosted.transcriptions).toHaveLength(1);await expect(page.locator('[data-message-role="user"]')).toHaveCount(0);
});

test("late hosted audio events cannot reset a newer playback",async({page})=>{
 const {copy}=languages.fi;await setupVoice(page,"fi","available",{privacy:false,provider:"gemini"});
 await mockHostedVoice(page,"fi");const {answer}=await submitQuestion(page,"fi");
 await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(1);
 await answer.getByRole("button",{name:copy.stopReading,exact:true}).click();
 await answer.getByRole("button",{name:copy.readAloud,exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.voiceTest.plays)).toBe(2);
 await page.evaluate(()=>{window.voiceTest.settleHosted(0);window.voiceTest.settleHosted(0,true);});
 await expect(answer.getByRole("button",{name:copy.stopReading,exact:true})).toBeVisible();
 await expect(answer.getByText(copy.geminiVoiceFailed,{exact:true})).toHaveCount(0);
 await page.evaluate(()=>window.voiceTest.settleHosted(1));
 await expect(answer.getByRole("button",{name:copy.readAloud,exact:true})).toBeEnabled();
});
