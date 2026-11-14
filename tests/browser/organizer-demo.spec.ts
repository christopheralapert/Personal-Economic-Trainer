import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import organizer from '../../complete-ui/data/organizer-1.v1.json';

const profile=organizer.profiles[0];
const amount=(n:number)=>new Intl.NumberFormat('fi-FI',{style:'currency',currency:'EUR'}).format(n/100);
test('organizer demo supports four free-text questions, previous-month context and source isolation',async({page})=>{
 const bank:string[]=[];page.on('request',r=>{if(/live-banking|enablebanking/.test(r.url()))bank.push(r.url());});
 await page.setViewportSize({width:390,height:844});await page.goto('/demo?dataset=organizer1');
 await expect(page.locator('header')).toContainText('S-Pankki challenge demo · Synthetic data · 30.9.2026');
 await expect(page.locator('[data-overview-block="period"]')).toContainText('September 2026');
 const august=profile.transactions.filter(r=>r.category==='taxi'&&r.booked_on>='2026-08-01'&&r.booked_on<'2026-09-01');
 await page.locator('#home-question').fill('How much did I spend on taxis last month?');await page.locator('#home-question').press('Enter');
 let answers=page.locator('[data-message-role="assistant"]');
 await expect(answers).toHaveCount(1);await expect(answers.last()).toContainText(amount(-august.reduce((s,r)=>s+r.amount_minor,0)));
 async function ask(question:string,count:number){await page.locator('main input').last().fill(question);await page.getByRole('button',{name:'Send question',exact:true}).click();await expect(answers).toHaveCount(count);await expect(page.getByRole('button',{name:'Send question',exact:true})).toBeDisabled();}
 await ask('What about the month before?',2);
 const july=profile.transactions.filter(r=>r.category==='taxi'&&r.booked_on>='2026-07-01'&&r.booked_on<'2026-08-01');
 await expect(answers.last()).toContainText(amount(-july.reduce((s,r)=>s+r.amount_minor,0)));
 await ask('What kind of spender am I?',3);await expect(answers.last()).toContainText('Home');
 await ask('What is safe for me to spend this week?',4);await expect(answers.last()).toContainText('How is this calculated?');
 await ask('How much could I save if I reduced dining out by 20%?',5);await expect(answers.last().getByRole('slider')).toBeVisible();
 await ask('Show transactions in August 2026',6);await expect(answers.last()).toContainText('Transactions');
 await expect(answers).toHaveCount(6);expect(bank).toEqual([]);
 await mkdir('.impeccable/review/junction',{recursive:true});
 for(const colorScheme of ['light','dark'] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`.impeccable/review/junction/after-coach-${colorScheme}.png`,fullPage:true,animations:'disabled'});await page.getByRole('tab',{name:'Overview',exact:true}).click();await page.screenshot({path:`.impeccable/review/junction/after-overview-${colorScheme}.png`,fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'Why?',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Observed available balance');await page.screenshot({path:`.impeccable/review/junction/after-basis-${colorScheme}.png`,animations:'disabled'});await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('tab',{name:'What if',exact:true}).click();await expect(page.getByRole('slider').first()).toBeVisible();await page.screenshot({path:`.impeccable/review/junction/after-whatif-${colorScheme}.png`,fullPage:true,animations:'disabled'});await page.getByRole('tab',{name:'Learn',exact:true}).click();await page.screenshot({path:`.impeccable/review/junction/after-learn-${colorScheme}.png`,fullPage:true,animations:'disabled'});await page.getByRole('tab',{name:'Coach',exact:true}).click();}
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByRole('button',{name:'Choose a demo profile',exact:true}).click();
 await page.getByRole('radio',{name:'S-Pankki / profile 2',exact:true}).click();
 await expect(page.locator('[data-overview-block="period"]')).toContainText('September 2026');
 await page.getByRole('tab',{name:'Coach',exact:true}).click();
 await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(0);
 expect(bank).toEqual([]);
});

test('public access screen opens the organizer profile even after another demo was selected',async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.goto('/access');
 await page.evaluate(()=>localStorage.setItem('money-coach-dataset.v1','extended'));
 const privateRequests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/v1/'))privateRequests.push(new URL(r.url()).pathname);});
 await page.getByRole('link',{name:'Try the demo'}).click();
 await expect(page.locator('header')).toContainText('S-Pankki challenge demo · Synthetic data · 30.9.2026');
 await expect(page.locator('[data-overview-block="period"]')).toContainText('September 2026');
 expect(privateRequests).toEqual([]);
});
