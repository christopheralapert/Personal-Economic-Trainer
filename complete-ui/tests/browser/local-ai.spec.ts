import {expectExtendedSource} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {extendedDemo} from "../../src/engine/datasets";
import {lastMonth} from "../../src/engine";
import {createComponentTools,propsSchemas} from "../../src/coach/catalog";
import {money,date} from "../../src/lib/format";
import {checkBasis} from "../basis";
import organizerSource from "../../data/organizer-1.v1.json";
import {loadTransactions} from "../../src/engine";
import {geminiCases} from "../../scripts/gemini-cases.mjs";
import type {ToolName} from "../../src/coach/catalog";
import {categoryLabel,translate} from "../../src/i18n/translate";
import {weeklyRange} from "../../src/engine/planning";
test.skip(process.env.MONEY_COACH_BROWSER_LIVE!=="true","Explicit live opt-in and a current local grant are required.");
test("local AI evaluation uses the actual browser SDK and two bounded model responses with extended-source figures",async({page})=>{
 test.skip(process.env.MONEY_COACH_ORGANIZER_SMOKE==="true","Organizer smoke uses only one model request.");
 test.setTimeout(45000);await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?dataset=extended");await expectExtendedSource(page);await page.getByRole("tab",{name:"Coach",exact:true}).click();
 const cases=[{question:"Can you add up my cab fares for October?",name:"showTransactions" as const,input:{period:lastMonth,category:"taxi"}},{question:"What if I cut dining out by 20%?",name:"showWhatIf" as const,input:{period:lastMonth,category:"dining",pct:20}}];
 let requests=0;page.on("request",request=>{if(request.url().endsWith("/api/chat") && request.method()==="POST")requests++;});
 for(const entry of cases){
  const requested=page.waitForRequest(value=>value.url().endsWith("/api/chat") && value.method()==="POST"),responded=page.waitForResponse(value=>value.url().endsWith("/api/chat"));
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill(entry.question);await page.getByRole("button",{name:"Send question",exact:true}).click();const response=await responded;
  expect(response.status()).toBe(200);expect(response.headers()["x-money-coach-source"],response.headers()["x-money-coach-evaluation"]).toBe("model");expect(response.headers()["cache-control"]).toBe("private, no-store");
  const stream=await response.text(),part=stream.split("\n").filter(line=>line.startsWith("data: {")).map(line=>JSON.parse(line.slice(6))).find(part=>part.type==="tool-output-available");
  expect(part).toBeDefined();const tool=createComponentTools(10,extendedDemo)[entry.name];const expected=await (tool.execute as (input:unknown,options:unknown)=>Promise<unknown>)(tool.inputSchema.parse(entry.input),{toolCallId:"oracle",messages:[]});expect(propsSchemas[entry.name].parse(part.output)).toEqual(expected);
  const payload=(await requested).postDataJSON();expect(payload.dataset).toBe("extended");expect(payload.period).toEqual(lastMonth);expect(payload.scope).toEqual({excludedAccounts:[],excludedCategories:[],corrections:{}});expect(payload.messages).toEqual([{role:"user",parts:[{type:"text",text:entry.question}]}]);expect(payload.locale).toBe("en");expect(payload.savingsPercent).toBe(10);
  await checkBasis(page,page.locator("article").last());await expect(page.getByText("The online response was unavailable.",{exact:false})).toHaveCount(0);
  await page.screenshot({path:path.resolve(__dirname,`../../../.impeccable/review/extended-data/live-${entry.name}.png`),fullPage:true});
 }
 expect(requests).toBe(2);await expect(page.locator("article")).toHaveCount(4);
});

test("one organizer question uses the hosted adapter and deterministic source figures",async({page})=>{
 test.skip(process.env.MONEY_COACH_ORGANIZER_SMOKE!=="true","Explicit organizer smoke opt-in is required.");
 test.setTimeout(60000);const data=loadTransactions(organizerSource),selected=process.env.MONEY_COACH_GEMINI_CASE??'taxi',cases=geminiCases[selected as keyof typeof geminiCases];expect(cases).toBeDefined();
 await page.setViewportSize({width:390,height:844});await page.goto("/?dataset=organizer1");
 await expect(page.locator('header')).toContainText('30.9.2026');
 const bank:string[]=[];let calls=0;
 page.on('request',r=>{if(/enablebanking|live-banking/.test(r.url()))bank.push(r.url());if(r.url().endsWith('/api/chat')&&r.method()==='POST')calls++;});
 for(const [index,entry] of cases.entries()) {
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/chat'));
 const requestPromise=page.waitForRequest(r=>r.url().endsWith('/api/chat') && r.method()==='POST');
 if(index===0) {await page.locator('#home-question').fill(entry.question);await page.locator('#home-question').press('Enter');}
 else {await page.getByRole('textbox',{name:'Your question',exact:true}).fill(entry.question);await page.getByRole('button',{name:'Send question',exact:true}).click();}
 const response=await responsePromise;
 const submitted=(await requestPromise).postDataJSON();expect(submitted.dataset).toBe('organizer1');expect(submitted.scope.excludedAccounts).toEqual([]);
 if(index>0) expect(submitted.context).toMatchObject({tool:'showTransactions',input:{category:'taxi',period:{start:'2026-08-01',end:'2026-09-01'}}});
 if(process.env.MONEY_COACH_LOCAL_GEMINI==='true' && response.headers()['x-money-coach-usage']) {
  const usage=JSON.parse(response.headers()['x-money-coach-usage']);
  const safe:Record<string,string|number>={};
  for(const field of ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount','totalTokenCount']) if(Number.isSafeInteger(usage[field]) && usage[field]>=0) safe[field]=usage[field];
  if(['STOP','MAX_TOKENS','SAFETY','RECITATION','OTHER','BLOCKLIST','PROHIBITED_CONTENT','SPII','MALFORMED_FUNCTION_CALL','UNEXPECTED_TOOL_CALL'].includes(usage.finishReason)) safe.finishReason=usage.finishReason;
  console.log(`Gemini usage: ${JSON.stringify(safe)}`);
 }
 if(process.env.MONEY_COACH_LOCAL_GEMINI==='true' && response.headers()['x-money-coach-source']!=='model') {
  const raw=response.headers()['x-money-coach-evaluation']??'unknown',diagnostic=/^[a-zA-Z0-9_:]+$/.test(raw)?raw:'unknown';
  const stage=diagnostic.split(':')[0];
  const explanations:Record<string,string>={transport_rejected:'The local request guard rejected the request.',network_error:'The provider could not be reached.',provider_http:'Google rejected the request; HTTP status and any safe code follow.',provider_stream:'The provider stream was interrupted.',sdk_response:'The model response could not be parsed or did not contain a usable tool result.',tool_validation:'The tool call did not pass validation.',native_tool_missing:'Google returned no function call.',native_tool_count:'Google returned more than one function call.',native_response_invalid:'Google returned an invalid response shape.',native_tool_invalid:'Google selected an unknown function.',native_arguments_invalid:'Google returned invalid function arguments.',native_usage_invalid:'Google did not return usable token counts.',timeout:'The request timed out.'};
  console.log(`Gemini diagnostic: ${diagnostic} — ${stage.startsWith('native_finish_') ? 'Google ended generation with the displayed finish reason.' : explanations[stage]??'The local evaluation could not produce a model result.'}`);
 }
 expect(response.status()).toBe(200);expect(response.headers()['x-money-coach-source'],response.headers()['x-money-coach-evaluation']).toBe('model');
 if(process.env.MONEY_COACH_LOCAL_GEMINI==='true') expect(response.headers()['x-money-coach-provider']).toBe(process.env.MONEY_COACH_GEMINI_MOCK==='true' ? 'gemini-direct-mock' : 'gemini-direct');
 const stream=await response.text(),events=stream.split('\n').filter(line=>line.startsWith('data: {')).map(line=>JSON.parse(line.slice(6))),part=events.find(value=>value.type==='tool-output-available'),selectedTool=events.find(value=>value.type==='tool-input-available');
 expect(part).toBeDefined();
 const name=entry.tool as ToolName,tool=createComponentTools(10,data)[name],input=tool.inputSchema.parse(entry.input);
 expect(selectedTool.toolName).toBe(name);expect(tool.inputSchema.parse(selectedTool.input)).toEqual(input);
 const expected=await (tool.execute as (input:unknown,options:unknown)=>Promise<unknown>)(input,{toolCallId:'oracle',messages:[]});
 expect(propsSchemas[name].parse(part.output)).toEqual(expected);
 const answer=page.locator('[data-message-role="assistant"]').last();
 if(name==='showTransactions') {const output=propsSchemas.showTransactions.parse(expected);if(output.netExpenses!==null) await expect(answer).toContainText(money(output.netExpenses));await expect(answer).toContainText(String(output.financialCount));if(output.rows.length) {await expect(answer).toContainText(output.rows[0].merchant);await expect(answer).toContainText(date(output.rows[0].booked_on));}}
 if(name==='showWhatIf') await expect(answer).toContainText(money(propsSchemas.showWhatIf.parse(expected).result.monthly));
 if(name==='showProfile') {const leading=propsSchemas.showProfile.parse(expected).result.leading;if(leading) await expect(answer).toContainText(categoryLabel(leading.key,(key,values)=>translate('en',key,values)));}
 if(name==='showSafeToSpend') {const safe=propsSchemas.showSafeToSpend.parse(expected),result=safe.result;expect(result.amount).toBeNull();expect(result.coverage).toBe('partial');await expect(answer).toContainText('Low confidence');await expect(answer).toContainText('Sep 1–Sep 30');if(safe.purpose==='spend') {const range=weeklyRange({data});if(range.low!==null && range.high!==null) {await expect(answer).toContainText(money(range.low));await expect(answer).toContainText(money(range.high));}}else await expect(answer).toContainText('Add income or review your bills');}
 const basisStart='period' in input ? (input.period as {start:string}).start : name==='showSafeToSpend' ? propsSchemas.showSafeToSpend.parse(expected).result.asOf.slice(0,7)+'-01' : undefined;
 await checkBasis(page,answer,undefined,basisStart ? date(basisStart) : undefined);
 }
 expect(calls).toBe(cases.length);expect(bank).toEqual([]);
});
