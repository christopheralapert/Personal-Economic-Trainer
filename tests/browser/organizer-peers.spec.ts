import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import profile from '../../complete-ui/data/organizer-1.v1.json';
import cohorts from '../../complete-ui/data/cohorts.v1.json';

for(const [width,height] of [[390,844],[1440,900]])for(const colorScheme of ['light','dark'] as const){
 test(`organizer personas and grounded peers ${width} ${colorScheme}`,async({page})=>{
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme,reducedMotion:'reduce'});
  const banks:string[]=[];page.on('request',request=>{if(/live-banking|enablebanking/.test(request.url()))banks.push(request.url());});
  const target='.cache/organizer-review';await mkdir(target,{recursive:true});
  await page.goto('/demo?dataset=organizer1');await expect(page.locator('header')).toContainText('S-Pankki challenge demo · Synthetic data · 30.9.2026');
  await expect(page.locator('[data-overview-block="baskets"]')).toContainText('Everyday');
  await page.screenshot({path:`${target}/after-overview-organizer1-${width}-${colorScheme}.png`,animations:'disabled'});
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Choose a demo profile',exact:true}).click();
  const dialog=page.getByRole('dialog');await expect(dialog.getByRole('radio')).toHaveCount(10);
  await page.screenshot({path:`${target}/after-picker-${width}-${colorScheme}.png`,animations:'disabled'});
  await dialog.getByRole('radio',{name:'Profile 4',exact:true}).click();
  await expect(page.locator('[data-overview-block="period"]')).toContainText('September 2026');
  await page.screenshot({path:`${target}/after-overview-organizer4-${width}-${colorScheme}.png`,animations:'disabled'});
  await page.goto('/demo?dataset=organizer1');await page.locator('#home-question').fill('How does my dining compare?');await page.locator('#home-question').press('Enter');
  const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer).toContainText('Synthetic Helsinki-region data');
  const amount=profile.profiles[0].transactions.filter(row=>row.category==='dining'&&row.booked_on>='2026-09-01'&&row.booked_on<'2026-10-01').reduce((sum,row)=>sum-row.amount_minor,0);
  const money=(cents:number)=>new Intl.NumberFormat('fi-FI',{style:'currency',currency:'EUR'}).format(cents/100);
  await expect(answer).toContainText(money(amount));await expect(answer).toContainText(`${cohorts.cells['35-44/02'].n} people`);
  await page.screenshot({path:`${target}/after-peer-${width}-${colorScheme}.png`,animations:'disabled'});
  await page.locator('main input').last().fill('What about the month before?');await page.getByRole('button',{name:'Send question',exact:true}).click();
  await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);await expect(answer).toContainText('Synthetic Helsinki-region data');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(banks).toEqual([]);
 });
}

for(const [locale,question,synthetic] of [["fi","Vertaa minua kaltaisiini","Synteettistä Helsingin seudun dataa"],["et","Võrdle mind minusugustega","Sünteetilised Helsingi piirkonna andmed"]]){
 test(`localized peer answer and picker ${locale}`,async({page})=>{
  await page.addInitScript(locale=>localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale,savings:10})),locale);
  await page.setViewportSize({width:390,height:844});await page.goto('/demo?dataset=organizer2');await page.locator('#home-question').fill(question);await page.locator('#home-question').press('Enter');
  const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer).toContainText(synthetic);await expect(answer).not.toContainText('Your monthly amount');await expect(answer).not.toContainText('Postal area');
 });
}
