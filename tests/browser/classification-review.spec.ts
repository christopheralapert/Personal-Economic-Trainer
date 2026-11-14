import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import fixture from '../../fixtures/synthetic/planning-ui.v1.json';
import {analysisTotals} from './analysis-support';

test('owned review persists through reload and the same scope feeds Overview and Coach',async({page})=>{
 const account='00000000-0000-0000-0000-000000000101';
 let version=9;const period={start:'2026-10-01',end_exclusive:'2026-11-01'};
 const rows=[1,2].map(i=>({id:`00000000-0000-0000-0001-${String(i).padStart(12,'0')}`,account_id:account,amount_minor:-1234,currency:'EUR',booked_on:'2026-10-15',status:'booked',merchant:`Synthetic review entry ${i}`,category:'unclassified',basket:'unresolved',economic_flow:'unknown'}));
 const scope=()=>({...analysisTotals({...period,currency:'EUR',account_ids:null,category:null,merchant:null,expected_data_version:null}).scope,account_ids:[account],data_mode:'live',data_version:version,dataset_coverage:'partial'});
 const totals=()=>{const expense=rows.filter(r=>r.economic_flow==='expense');return {...analysisTotals({...period,currency:'EUR',account_ids:null,category:null,merchant:null,expected_data_version:null}),scope:scope(),gross_minor:expense.length*1234,refunds_minor:0,net_minor:expense.length*1234,expense_count:expense.length,refund_count:0,unresolved_flow_count:rows.filter(r=>r.economic_flow==='unknown').length,category_baskets:expense.map(r=>({label:r.category,basket:r.basket,gross_minor:1234,refunds_minor:0,net_minor:1234,transaction_count:1})),merchants:[]};};
 let writes=0;const bank:string[]=[];
 await page.clock.install({time:new Date('2026-11-13T08:00:00Z')});
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1/','');
  const reply=(json:unknown,status=200)=>route.fulfill({status,json});
  if(path==='auth/session')return reply({...fixture.session,synthetic:false});
  if(path.includes('live-banking')){bank.push(path);return reply({},503);}
  if(path==='dashboard')return reply({data_version:version,synthetic:false,live_banking_enabled:true,model_policy:'paid_allowed',coverage:'partial_or_unverified',accounts:[{id:account,name:'Synthetic test account',currency:'EUR',account_type:'current',included:true,source:null,access_status:'observed',balance:{amount_minor:10000,kind:'booked',observed_at:'2026-11-13T08:00:00Z',pending_reflection:'unknown'}}]});
  if(path==='ledger/inventory')return reply({scope:scope(),total_booked_count:2,period_booked_count:2,period_unresolved_count:rows.filter(r=>r.economic_flow==='unknown').length,available_start:period.start,available_end_exclusive:period.end_exclusive});
  if(path==='ledger/transactions')return reply({scope:scope(),rows:rows.filter(r=>url.searchParams.get('needs_review')!=='true'||r.economic_flow==='unknown'),next_cursor:null});
  if(path.endsWith('/classification')){
   writes++;const body=request.postDataJSON();expect(request.headers()['x-csrf-token']).toBe(fixture.session.csrf_token);
   expect(body.expected_data_version).toBe(version);const row=rows.find(r=>path.includes(r.id))!;
   Object.assign(row,{economic_flow:body.economic_flow,category:body.category??'unclassified',basket:body.basket});version++;
   return reply({row,data_version:version});
  }
  if(path==='analysis/tools/execute')return reply({name:'spending_totals',result:totals()});
  if(path==='analysis/spending/reduction')return reply({status:'blocked',result:{amount_minor:null,currency:'EUR'},baseline:totals(),counterfactual_net_minor:null,blockers:[{code:'SCENARIO_HISTORY_INCOMPLETE',message:'History is partial.',action:'review'}],assumptions:['A plan is not money moved.']});
  if(path==='coach/query')return reply({read_only:true,persisted:false,card:null,habits:null,transactions:{scope:scope(),rows,next_cursor:null},model_usage:null,interpretation:{method:'rule',resolved_at:'2026-11-13T08:00:00Z',status:'ready',reason:'SUPPORTED_QUERY',message:'Scoped server records',intent:{kind:'analysis',tool:{name:'ledger_transactions',arguments:{...period,currency:'EUR',account_ids:[account],category:null,merchant:null,expected_data_version:version,status:'booked',spending_only:false,limit:50,cursor:null}}}}});
  return reply({},404);
 });
 await mkdir('.impeccable/review/classification',{recursive:true});
 await page.setViewportSize({width:390,height:844});await page.goto('/transactions?start=2026-10-01&end=2026-11-01');
 await expect(page.locator('[data-ledger-row]')).toHaveCount(2);
 await page.getByRole('button',{name:'Needs review (2)',exact:true}).click();
 await page.getByRole('button',{name:'Review classification: Synthetic review entry 1',exact:true}).click();
 await page.getByRole('radio',{name:'Expense',exact:true}).click();
 await page.getByLabel('Category',{exact:true}).selectOption('taxi');await page.getByLabel('Spending basket',{exact:true}).selectOption('everyday');
 for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/classification/review-${scheme}.png`,animations:'disabled'});}
 await page.getByRole('button',{name:'Save classification',exact:true}).click();
 await expect(page.getByText('Classification saved',{exact:true})).toBeVisible();await expect(page.locator('[data-ledger-row]')).toHaveCount(1);
 await page.reload();await expect(page.locator('[data-ledger-row]')).toHaveCount(2);await expect(page.locator('[data-ledger-row]').first()).toContainText('Taxis');
 await page.getByRole('button',{name:'Review classification: Synthetic review entry 2',exact:true}).click();await page.getByRole('radio',{name:'Transfer between my accounts',exact:true}).click();await page.getByRole('button',{name:'Save classification',exact:true}).click();
 await expect(page.getByRole('button',{name:'Needs review (0)',exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Overview',exact:true}).click();await expect(page.locator('[data-chart-total]')).toContainText('12,34');
 for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/classification/overview-${scheme}.png`,fullPage:true,animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.getByRole('link',{name:'Coach',exact:true}).click();await page.getByLabel('Question (English)',{exact:true}).fill('Show transactions in October 2026');await page.getByRole('button',{name:'Read my records',exact:true}).click();
 await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(2);await expect(page.locator('[data-coach-ledger-row]').first()).toContainText('Taxis');
 await page.screenshot({path:'.impeccable/review/classification/coach.png',fullPage:true,animations:'disabled'});
 await page.getByLabel('Question (English)',{exact:true}).focus();
 await page.evaluate(()=>{Object.defineProperty(window.visualViewport!,'height',{configurable:true,get:()=>500});window.visualViewport!.dispatchEvent(new Event('resize'));});
 await expect.poll(()=>page.evaluate(()=>document.documentElement.style.getPropertyValue('--keyboard-inset'))).toBe('344px');
 const composer=await page.locator('form').last().boundingBox(),nav=await page.getByRole('navigation',{name:'Main navigation'}).boundingBox();
 expect(composer!.y+composer!.height).toBeLessThanOrEqual(nav!.y+1);expect(nav!.y+nav!.height).toBeLessThanOrEqual(501);
 await page.getByRole('link',{name:'What if',exact:true}).click();
 await expect(page.getByRole('slider',{name:'Reduce selected spending by'})).toHaveAttribute('aria-valuenow','20');
 await page.getByRole('button',{name:'Calculate from my records',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Needs your input',exact:true})).toBeVisible();
 for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/classification/scenario-${scheme}.png`,fullPage:true,animations:'disabled'});}
 await page.getByRole('link',{name:'Learn',exact:true}).click();
 await expect(page.locator('#everyday')).toContainText('12,34');
 for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/classification/learn-${scheme}.png`,fullPage:true,animations:'disabled'});}
 expect(writes).toBe(2);expect(bank).toEqual([]);
});
