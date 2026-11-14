import {test,expect,type Page} from '@playwright/test';
import path from 'node:path';
const api=process.env.MONEYLENS_AUTO_CLASSIFICATION_API??'http://127.0.0.1:18052',control={'X-MoneyLens-Rehearsal':'synthetic-amount-guard'};
const fixture=(name:string)=>path.resolve('.cache/auto-classification-fixtures',name);
const item=(page:Page,name:string)=>page.locator(`[data-statement-file="${name}"]`);
async function identity(page:Page,subject:string){await page.goto('/api/v1/auth/login');await page.getByRole('link',{name:subject,exact:true}).click();await page.goto('/banks');await expect(page.getByLabel('Choose statements')).toBeVisible();}
async function choose(page:Page,name:string){await page.getByLabel('Choose statements').setInputFiles(fixture(name));const start=performance.now(),response=page.waitForResponse(r=>r.url().endsWith('/statements/wise/preview'));await page.getByRole('button',{name:'Preview statements',exact:true}).click();const result=await(await response).json();await expect(item(page,name).getByRole('region',{name:'Proposed categories',exact:true})).toBeVisible();return {result,ms:Math.round(performance.now()-start)};}
async function account(page:Page,name:string){await item(page,name).getByLabel('Account',{exact:true}).selectOption('new');await item(page,name).getByLabel('New account name').fill('Synthetic automatic '+name);}
async function confirm(page:Page){const wait=page.waitForResponse(r=>r.url().endsWith('/statements/wise/confirm'));await page.getByRole('button',{name:'Confirm imports',exact:true}).click();const response=await wait;expect(response.status()).toBe(200);return response.json();}
async function counts(page:Page){return (await page.request.get(api+'/rehearsal/counts',{headers:control})).json();}
for(const format of ['csv','xlsx'])test(`${format}: automatic taxi preview to Overview, Coach and evidence without manual classification`,async({page},info)=>{
 await identity(page,format==='csv'?'auto-main':'auto-xlsx');const name='auto-taxis.'+format,{result,ms}=await choose(page,name);
 expect(result.classifications.map((r:{category:string})=>r.category)).toEqual(['taxi','taxi']);await expect(item(page,name)).toContainText('Source rule');
 await expect(item(page,name).getByRole('combobox',{name:'Category 1',exact:true})).toHaveValue('taxi');await account(page,name);
 await page.screenshot({path:info.outputPath('phone-automatic-preview.png'),animations:'disabled',fullPage:true});
 if(format==='csv'){await page.setViewportSize({width:1280,height:900});await page.screenshot({path:info.outputPath('desktop-automatic-preview.png'),animations:'disabled',fullPage:true});await page.setViewportSize({width:390,height:844});}
 const start=performance.now(),saved=await confirm(page);expect(saved.added_count).toBe(2);await item(page,name).getByRole('link',{name:'View transactions',exact:true}).click();await expect(page.locator('[data-ledger-row]')).toHaveCount(2);const visibleMs=Math.round(performance.now()-start);
 await page.reload();await expect(page.locator('[data-ledger-row]')).toHaveCount(2);
 const ledger=await page.evaluate(async()=>await(await fetch('/api/v1/ledger/transactions?start=2026-10-01&end_exclusive=2026-11-01')).json());expect(ledger.rows.map((r:{category:string})=>r.category)).toEqual(['taxi','taxi']);
 const accountId=saved.files[0].account_id;
 await page.goto('/?'+new URLSearchParams({start:'2026-10-01',end:'2026-11-01',account_id:accountId}));
 await expect(page.locator('main')).toContainText('30,97');
 await page.goto('/coach?'+new URLSearchParams({start:'2026-10-01',end:'2026-11-01',account_id:accountId}));await page.locator('#coach-question').fill('How much did I spend on taxis in October 2026?');
 const response=page.waitForResponse(r=>r.url().endsWith('/coach/query')),asked=performance.now();await page.getByRole('button',{name:'Read my records',exact:true}).click();const answer=await(await response).json();expect(answer.card.answer.artifact.result.net_minor).toBe(3097);await expect(page.locator('[data-coach-answer]').last()).toContainText(/30[,.]97/);
 const questionMs=Math.round(performance.now()-asked);await page.getByRole('button',{name:'Underlying transactions',exact:true}).click();await expect(page.locator('[data-coach-evidence-row]')).toHaveCount(2);await page.locator('[data-coach-evidence-row]').first().getByRole('button').click();await expect(page.getByRole('dialog',{name:'Transaction details',exact:true})).toContainText('BOLT *RIDE');
 console.log(JSON.stringify({format,previewMs:ms,confirmationToHistoryMs:visibleMs,coachVisibleMs:questionMs,netMinor:3097,transport:'local rules, real PostgreSQL, signed test OIDC'}));
});

test('manual edits win over late suggestions; privacy and repeat imports retain classifications',async({page})=>{
 await page.request.post(api+'/rehearsal/classification-provider',{headers:control,data:{provider:'mock'}});
 await identity(page,'auto-manual');const name='auto-mixed.csv';await choose(page,name);await account(page,name);
 await page.getByLabel('Privacy mode',{exact:true}).uncheck();await page.getByLabel('Allow cloud classification',{exact:true}).check();
 let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
 await page.route('**/api/v1/statements/wise/classify',async route=>{const response=await route.fetch();await gate;await route.fulfill({response});});
 const pending=page.waitForRequest(r=>r.url().endsWith('/statements/wise/classify'));await page.getByRole('button',{name:'Suggest categories with Gemini',exact:true}).click();await pending;
 await item(page,name).getByRole('combobox',{name:'Category 3',exact:true}).selectOption('dining');
 await item(page,name).locator('[data-import-classification="2"]').getByRole('checkbox').check();
 await page.getByLabel('Privacy mode',{exact:true}).check();const delivered=page.waitForResponse(r=>r.url().endsWith('/statements/wise/classify'));release();await delivered;await page.unroute('**/api/v1/statements/wise/classify');
 await expect(item(page,name).getByRole('combobox',{name:'Category 3',exact:true})).toHaveValue('dining');
 await expect(item(page,name)).not.toContainText('Gemini suggestion');
 const before=await counts(page),saved=await confirm(page);expect(saved.added_count).toBe(9);
 await page.goto('/banks');await choose(page,name);await item(page,name).getByLabel('Account',{exact:true}).selectOption(saved.files[0].account_id);expect((await confirm(page)).added_count).toBe(0);
 const rows=await page.evaluate(async()=>await(await fetch('/api/v1/ledger/transactions?start=2026-10-01&end_exclusive=2026-11-01')).json());
 expect(rows.rows.find((r:{amount_minor:number})=>r.amount_minor===-400).category).toBe('dining');expect(rows.rows.find((r:{amount_minor:number})=>r.amount_minor===-200).category).toBe('unclassified');
 const after=await counts(page);expect(after.classification_mock).toBe(before.classification_mock);expect(after.classification_real).toBe(before.classification_real);
 await page.goto('/banks');await choose(page,'auto-later.csv');await expect(item(page,'auto-later.csv').getByRole('combobox',{name:'Category 1',exact:true})).toHaveValue('dining');await expect(item(page,'auto-later.csv')).toContainText('Your rule / review');
});

test('mock Gemini deduplicates brand aliases, keeps transfers local and allows manual correction',async({page})=>{
 await page.request.post(api+'/rehearsal/classification-provider',{headers:control,data:{provider:'mock'}});await identity(page,'auto-privacy');await choose(page,'auto-mixed.csv');
 await page.getByLabel('Privacy mode',{exact:true}).uncheck();await page.getByLabel('Allow cloud classification',{exact:true}).check();const before=await counts(page),response=page.waitForResponse(r=>r.url().endsWith('/statements/wise/classify'));
 await page.getByRole('button',{name:'Suggest categories with Gemini',exact:true}).click();const result=await(await response).json();expect(result.eligible_merchants).toBe(1);expect(result.model_calls).toBe(1);
 await expect(page.getByRole('button',{name:'Suggest categories with Gemini',exact:true})).toBeEnabled();await item(page,'auto-mixed.csv').getByRole('button',{name:'Show all rows',exact:true}).click();
 await expect(item(page,'auto-mixed.csv').getByRole('combobox',{name:'Category 3',exact:true})).toHaveValue('coffee');
 await item(page,'auto-mixed.csv').getByRole('combobox',{name:'Category 3',exact:true}).selectOption('dining');
 const after=await counts(page);expect(after.classification_mock-before.classification_mock).toBe(1);expect(after.classification_real).toBe(before.classification_real);
 await page.getByLabel('Privacy mode',{exact:true}).check();await expect(page.getByRole('button',{name:'Suggest categories with Gemini',exact:true})).toHaveCount(0);await expect(item(page,'auto-mixed.csv').getByRole('combobox',{name:'Category 3',exact:true})).toHaveValue('dining');
});

test('one real synthetic Gemini classification batch',async({page},info)=>{
 test.skip(process.env.MONEYLENS_CLASSIFICATION_REAL!=='true','Explicit real-model opt-in required');
 expect((await page.request.post(api+'/rehearsal/classification-provider',{headers:control,data:{provider:'gemini'}})).status()).toBe(200);
 await identity(page,'auto-gemini');const local=await choose(page,'auto-mixed.csv');await page.getByLabel('Privacy mode',{exact:true}).uncheck();await page.getByLabel('Allow cloud classification',{exact:true}).check();
 const before=await counts(page),response=page.waitForResponse(r=>r.url().endsWith('/statements/wise/classify')),start=performance.now();await page.getByRole('button',{name:'Suggest categories with Gemini',exact:true}).click();const http=await response,result=await http.json();
 expect(http.status()).toBe(200);expect(result.diagnostic,JSON.stringify({diagnostic:result.diagnostic,calls:result.model_calls})).toBe('gemini_suggestions');expect(result.previews[0].suggestions).toEqual([{index:2,category:'coffee'},{index:3,category:'coffee'}]);
 await expect(page.getByText('Suggestions ready. Review them before confirming.',{exact:true})).toBeVisible();const fullMs=Math.round(performance.now()-start),after=await counts(page);expect(after.classification_real-before.classification_real).toBe(1);expect(after.classification_mock).toBe(before.classification_mock);
 await page.screenshot({path:info.outputPath('phone-real-suggestions.png'),fullPage:true,animations:'disabled'});
 await account(page,'auto-mixed.csv');const saved=await confirm(page);expect(saved.added_count).toBe(9);
 await page.goto('/coach?'+new URLSearchParams({account_id:saved.files[0].account_id,start:'2026-10-01',end:'2026-11-01'}));await page.getByLabel('Privacy mode',{exact:true}).check();await page.locator('#coach-question').fill('How much did I spend on coffee in October 2026?');const answer=page.waitForResponse(r=>r.url().endsWith('/coach/query'));await page.getByRole('button',{name:'Read my records',exact:true}).click();const card=await(await answer).json();expect(card.source).toBe('rule');expect(card.card.answer.artifact.result.net_minor).toBe(600);await expect(page.locator('[data-coach-answer]').last()).toContainText(/6[,.]00/);
 await page.getByRole('button',{name:'Underlying transactions',exact:true}).click();await expect(page.locator('[data-coach-evidence-row]')).toHaveCount(2);
 console.log(JSON.stringify({realGeminiClassification:{status:http.status(),modelCalls:result.model_calls,sanitizedMerchants:result.sent_merchants,suggestions:result.previews[0].suggestions.length,localPreviewMs:local.ms,modelMs:result.model_ms,suggestionVisibleMs:fullMs,diagnostic:result.diagnostic}}));
});

test('fresh owner cannot see another owners imports, previews, rules or Coach account selection',async({browser})=>{
 const a=await browser.newContext({viewport:{width:390,height:844}}),b=await browser.newContext({viewport:{width:390,height:844}});
 try{const first=await a.newPage(),second=await b.newPage();await identity(first,'auto-main');const preview=await choose(first,'auto-mixed.csv');const accountId=await first.evaluate(async()=>((await(await fetch('/api/v1/accounts')).json())[0].id));
 await identity(second,'other-owner');expect(await second.evaluate(async()=>await(await fetch('/api/v1/accounts')).json())).toEqual([]);
 const statuses=await second.evaluate(async({accountId,previewId})=>{const session=await(await fetch('/api/v1/auth/session')).json();return [
 (await fetch('/api/v1/ledger/transactions?'+new URLSearchParams({start:'2026-10-01',end_exclusive:'2026-11-01',account_id:accountId}))).status,
 (await fetch('/api/v1/statements/wise/classify',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'X-MoneyLens-Session-ID':session.session_id},body:JSON.stringify({preview_ids:[previewId],privacy:true})})).status];},{accountId,previewId:preview.result.id});expect(statuses).toEqual([404,404]);
 await choose(second,'auto-later.csv');await expect(item(second,'auto-later.csv').getByRole('combobox',{name:'Category 1',exact:true})).toHaveValue('');await second.goto('/coach');await expect(second.getByRole('combobox',{name:'Account scope',exact:true}).locator('option')).toHaveCount(1);
 }finally{await a.close();await b.close();}
});

test('700-row local preview retains bounded rendering and single bulk confirmation',async({page})=>{
 await identity(page,'auto-empty');const {ms}=await choose(page,'auto-700.csv');await account(page,'auto-700.csv');expect(await item(page,'auto-700.csv').locator('[data-import-classification]').count()).toBe(10);
 const start=performance.now(),saved=await confirm(page);expect(saved.added_count).toBe(700);await item(page,'auto-700.csv').getByRole('link',{name:'View transactions',exact:true}).click();await expect(page.locator('[data-ledger-row]')).toHaveCount(50);
 console.log(JSON.stringify({rows:700,previewMs:ms,confirmationToHistoryMs:Math.round(performance.now()-start),modelCalls:0}));expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(390);
});
