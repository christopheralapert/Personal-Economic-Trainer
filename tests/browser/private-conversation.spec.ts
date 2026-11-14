import {test,expect} from '@playwright/test';

// Requires the explicitly isolated run_guard_preview.py service. Test OIDC is
// signed locally, not Auth0. Provider authenticity is selected by the test flag.
test('signed private import, generated dialogue, grounded taxi answer and Privacy isolation',async({page})=>{
 const real=process.env.PRIVATE_CONVERSATION_REAL==='true';
 await page.addInitScript(()=>{localStorage.setItem('money-coach-privacy.v1','false');localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale:'en',savings:10}));});
 await page.goto('/api/v1/auth/login?return_to=/import');await page.getByRole('link',{name:process.env.PRIVATE_CONVERSATION_IDENTITY??'model-review',exact:true}).click();
 await expect(page).toHaveURL(/\/import/);
 const existing=(await page.evaluate(async()=>await(await fetch('/api/v1/accounts')).json()) as {id:string;name:string}[]).find(account=>account.name==='Synthetic conversation account');
 const file=await page.request.get('/api/demo-statements/sample/auto-taxis.csv');expect(file.status()).toBe(200);
 await page.getByLabel('Choose statements').setInputFiles({name:'auto-taxis.csv',mimeType:'text/csv',buffer:await file.body()});
 await page.getByRole('button',{name:'Preview statements',exact:true}).click();const item=page.locator('[data-statement-file="auto-taxis.csv"]');
 await expect(item.getByRole('region',{name:'Proposed categories',exact:true})).toBeVisible();
 await item.getByLabel('Account',{exact:true}).selectOption(existing?.id??'new');if(!existing)await item.getByLabel('New account name').fill('Synthetic conversation account');
 const started=performance.now(),saved=page.waitForResponse(response=>response.url().endsWith('/statements/wise/confirm'));
 await page.getByRole('button',{name:'Confirm imports',exact:true}).click();expect((await(await saved).json()).added_count).toBe(existing?0:2);
 await item.getByRole('link',{name:'View transactions',exact:true}).click();await expect(page.locator('main li')).toHaveCount(2);
 const importMs=Math.round(performance.now()-started);
 await page.goto('/coach');const privacy=page.getByRole('checkbox',{name:'Privacy mode',exact:true});await privacy.uncheck();
 const input=page.locator('#coach-question');
 async function ask(question:string){await input.fill(question);const start=performance.now(),pending=page.waitForResponse(response=>response.url().endsWith('/coach/query'));await page.getByRole('button',{name:'Read my records',exact:true}).click();const response=await pending,body=await response.json();expect(response.status()).toBe(200);return {body,visibleMs:Math.round(performance.now()-start)};}
 const general=await ask('What is an impulse purchase?');expect(general.body).toMatchObject({source:'model',provider:'gemini-direct',interpretation:{status:'answered',reason:'GENERAL_CONVERSATION'}});
 await expect(page.locator('[data-coach-answer]').last()).toContainText(/impulse|unplanned/iu);
 // The fixture runner has a synthetic clock and explicit model rate limit.
 await page.waitForTimeout(5100);
 const taxi=await ask('How much did I spend on taxis in October 2026?');expect(taxi.body).toMatchObject({source:'model',provider:'gemini-direct',model_usage:{calls:2}});
 expect(taxi.body.card.answer.artifact.result.net_minor).toBe(3097);await expect(page.locator('[data-coach-answer]').last()).toContainText(/30[,.]97/);
 await page.getByRole('button',{name:'Underlying transactions',exact:true}).last().click();await expect(page.locator('[data-coach-evidence-row]')).toHaveCount(2);
 await page.locator('[data-coach-evidence-row]').first().getByRole('button').click();await expect(page.getByRole('dialog',{name:'Transaction details',exact:true})).toContainText('BOLT *RIDE');await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('dialog',{name:'Underlying transactions',exact:true}).getByRole('button',{name:'Done',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 const before=await page.request.get('http://127.0.0.1:'+ (process.env.PRIVATE_CONVERSATION_API_PORT??'18077')+'/rehearsal/counts',{headers:{'x-moneylens-rehearsal':'synthetic-amount-guard'}});const counts=await before.json();
 expect(counts.real_text).toBe(real);
 await privacy.check();const local=await ask('How much did I spend on taxis in October 2026?');expect(local.body.source).toBe('rule');
 const after=await page.request.get('http://127.0.0.1:'+(process.env.PRIVATE_CONVERSATION_API_PORT??'18077')+'/rehearsal/counts',{headers:{'x-moneylens-rehearsal':'synthetic-amount-guard'}});expect(await after.json()).toEqual(counts);
 console.log(JSON.stringify({testOIDC:true,realAuth0:false,realGemini:real,importRows:2,importToHistoryMs:importMs,generalVisibleMs:general.visibleMs,taxiVisibleMs:taxi.visibleMs,serverScopeVerified:true,privateProviderCalls:real?counts.coach_real:counts.gemini}));
});
