import {test,expect,type Page} from '@playwright/test';
import {en,fi,et} from '../../frontend/coach/src/i18n/dictionaries';

async function question(page:Page,text:string,copy:typeof en=en){
 const input=page.getByRole('textbox',{name:copy.questionLabel,exact:true});
 await input.fill(text);
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat');
 await page.getByRole('button',{name:copy.send,exact:true}).click();
 const response=await pending;
 expect(response.headers()['x-money-coach-source']).toBe('rule');
 expect(response.headers()['x-money-coach-evaluation']).toBe('privacy_rule');
 await expect(input).toBeEditable();
 return page.locator('[data-message-role="assistant"]').last();
}

for(const locale of ['en','fi','et'] as const)test(`${locale}: organizer evidence, learning and 20% scenario use the same synthetic data`,async({page},info)=>{
 const c={en,fi,et}[locale],privateRequests:string[]=[];
 await page.addInitScript(locale=>{
  localStorage.setItem('money-coach-privacy.v1','true');
  localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale,savings:10}));
 },locale);
 page.on('request',r=>{if(/\/api\/v1\/(?!auth\/session)|enablebanking|\/live-banking\//.test(r.url()))privateRequests.push(new URL(r.url()).pathname);});
 await page.goto('/demo?dataset=organizer1&tab=coach');
 const taxi=await question(page,c.qTaxi,c);
 await expect(taxi).toContainText('30,97');
 await expect(taxi.locator('[data-spoken-answer]')).toContainText({en:'August 2026',fi:'elokuussa 2026',et:'august 2026'}[locale]);
 await taxi.locator('li button').first().click();
 await expect(page.getByRole('dialog')).toContainText('MRC-TRN-0063');
 await page.getByRole('dialog').getByRole('button',{name:c.done,exact:true}).click();
 const scenario=await question(page,c.qWhatif,c);
 await expect(scenario.getByRole('slider')).toHaveAttribute('aria-valuenow','20');
 await expect(scenario).toContainText('797,88');await expect(scenario).toContainText('159,58');
 await page.getByRole('tab',{name:c.learn,exact:true}).click();
 for(const name of [c.regularShort,c.surprisesShort,c.everydayShort,c.fund,c.savingConcept,c.habit])
  await expect(page.getByRole('button',{name:new RegExp(`^${name} `)})).toBeVisible();
 await expect(page.locator('main')).not.toContainText(c.partial);
 await page.getByRole('tab',{name:c.whatif,exact:true}).click();
 await expect(page.getByRole('slider').first()).toBeVisible();
 await page.getByRole('tab',{name:c.overview,exact:true}).click();
 await expect(page.locator('header').getByRole('link',{name:'Try file import',exact:true})).toHaveCount(0);
 await expect(page.getByRole('button',{name:c.why,exact:true})).toBeVisible();
 await page.getByRole('button',{name:c.why,exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText(c.planningReviewTitle);
 await expect(page.getByRole('dialog')).toContainText(c.incompleteHistory);
 await page.getByRole('dialog').getByRole('button',{name:c.done,exact:true}).click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 if(locale==='en'&&info.project.name.startsWith('chrome'))await page.screenshot({path:info.outputPath('organizer-overview.png'),fullPage:true});
 expect(privateRequests).toEqual([]);
});

test('reviewing demo assumptions never upgrades incomplete data into a reliable allowance',async({page})=>{
 await page.goto('/demo?dataset=organizer1&tab=coach');
 let answer=await question(page,en.qSafe);
 await expect(answer).toContainText(en.confidenceLow);
 await answer.getByRole('button',{name:en.calculation,exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('region',{name:en.planningReviewTitle})).toBeVisible();
 await page.getByRole('dialog').getByRole('button',{name:en.confirmBills,exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText(en.planningReviewSnapshotOnly);
 await page.getByRole('dialog').getByRole('button',{name:en.done,exact:true}).click();
 await expect(answer).toContainText(en.confidenceLow);await expect(answer).not.toContainText(en.confidenceMedium);
 answer=await question(page,en.qSave);
 await expect(answer).toContainText(en.planningReviewNoAllowance);
 await expect(answer.getByRole('button',{name:en.goal,exact:true})).toBeVisible();
});

test('anonymous sample upload reaches persisted history and October Coach without bank or sign-in',async({page},info)=>{
 const privateRequests:string[]=[];
 page.on('request',r=>{if(/\/api\/v1\/(?!auth\/session)|\/rehearsal\/authorize|enablebanking/.test(r.url()))privateRequests.push(new URL(r.url()).pathname);});
 await page.goto('/demo');
 const actions=page.locator('main a');
 await expect(actions.nth(0)).toHaveText('Try file import');
 await expect(actions.nth(1)).toHaveText('Try with sample data');
 await page.getByRole('link',{name:'Try file import',exact:true}).click();
 await expect(page.getByRole('button',{name:'Choose files',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Use sample file',exact:true}).click();
 const file=page.locator('[data-statement-file="auto-taxis.csv"]');
 await expect(file).toContainText('Source rule');
 const start=performance.now();
 await page.getByRole('button',{name:'Confirm imports',exact:true}).click();
 await file.getByRole('link',{name:'View transactions',exact:true}).click();
 await expect(page.locator('main li')).toHaveCount(2);
 const importToHistoryMs=Math.round(performance.now()-start);
 await page.reload();await expect(page.locator('main li')).toHaveCount(2);
 await page.getByRole('link',{name:'Ask Coach',exact:true}).click();
 const submitted=performance.now(),answer=await question(page,'How much did I spend on taxis in October 2026?');
 await expect(answer).toContainText('30,97');
 await expect(answer.locator('[data-spoken-answer]')).toContainText('October 2026');
 await expect(answer.locator('li')).toHaveCount(2);
 const questionToVisibleMs=Math.round(performance.now()-submitted);
 for(const index of [0,1]){
  await answer.locator('li button').nth(index).click();await expect(page.getByRole('dialog')).toContainText('BOLT *RIDE');
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 }
 expect(privateRequests).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 console.log(JSON.stringify({project:info.project.name,syntheticRows:2,importToHistoryMs,questionToVisibleMs,transport:'local-privacy',realBank:false}));
});
