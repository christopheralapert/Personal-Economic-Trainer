import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';

test('Junction demo rehearses baskets, explanation, coach and scenario without live banking',async({page})=>{
  const banking:string[]=[];const answers:string[]=[];
  page.on('request',request=>{if(request.url().includes('/live-banking/')||request.url().includes('api.enablebanking.com'))banking.push(request.url());});
  page.on('response',response=>{if(new URL(response.url()).pathname==='/api/chat')answers.push(response.headers()['x-money-coach-source']??'unknown');});
  await page.setViewportSize({width:390,height:844});await page.goto('/demo?dataset=starter');
  await expect(page.locator('header')).toContainText('Synthetic');
  await expect(page.locator('[data-overview-block="baskets"] button')).toHaveCount(3);
  await expect(page.locator('[data-overview-block="baskets"]')).toContainText('Regular');
  await expect(page.locator('[data-overview-block="baskets"]')).toContainText('Surprises');
  await expect(page.locator('[data-overview-block="baskets"]')).toContainText('Everyday');
  await page.getByRole('button',{name:'Why?',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('How is this calculated?');
  await mkdir('.impeccable/review',{recursive:true});
  await page.screenshot({path:'.impeccable/review/junction-demo-calculation.png',animations:'disabled'});
  await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
  for(const theme of ['light','dark'] as const){
    await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:`.impeccable/review/junction-demo-overview-${theme}.png`,fullPage:true,animations:'disabled'});
  }
  await page.locator('#home-question').fill('How much did I spend on taxis last month?');
  await page.locator('#home-question').press('Enter');
  await expect(page.locator('main')).toContainText('40,00');
  await page.getByRole('tab',{name:'Coach',exact:true}).click();
  await page.locator('main input').last().fill('What if I cut dining out by 20%?');
  await page.getByRole('button',{name:'Send question',exact:true}).click();
  await expect(page.locator('main')).toContainText('50,00');
  await page.screenshot({path:'.impeccable/review/junction-demo-coach.png',fullPage:true,animations:'disabled'});
  await page.getByRole('tab',{name:'What if',exact:true}).click();
  await expect(page.getByRole('slider').first()).toBeVisible();
  await expect(page.getByRole('button',{name:/Set aside/})).toBeVisible();
  await page.screenshot({path:'.impeccable/review/junction-demo-scenario.png',fullPage:true,animations:'disabled'});
  expect(answers).toEqual(['rule','rule']);expect(banking).toEqual([]);
});
