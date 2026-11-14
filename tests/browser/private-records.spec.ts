import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import fixture from '../../fixtures/synthetic/planning-ui.v1.json';
import {analysisTotals} from './analysis-support';

test('private unresolved records are visible, paginated and used by model-interpreted Coach',async({page})=>{
 const ids=['00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-000000000102'];
 const period={start:'2026-08-01',end_exclusive:'2026-11-14'};
 const scope={...analysisTotals({...period,currency:'EUR',account_ids:null,category:null,merchant:null,expected_data_version:null}).scope,
  account_ids:ids,data_mode:'live',data_version:9,dataset_coverage:'partial'};
 const rows=Array.from({length:73},(_,i)=>({id:`00000000-0000-0000-0001-${String(i+1).padStart(12,'0')}`,account_id:ids[i%2],amount_minor:-100,currency:'EUR',booked_on:'2026-10-15',status:'booked',merchant:`Offline fixture entry ${i+1}`,category:'unclassified',basket:'unresolved',economic_flow:'unknown'}));
 let coachCalls=0;const coachBodies:unknown[]=[];const banking:string[]=[];
 await page.clock.install({time:new Date('2026-11-13T08:00:00Z')});
 await page.route('**/api/v1/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/api/v1/','');
  const reply=(json:unknown,status=200)=>route.fulfill({status,json});
  if(path==='auth/session')return reply({...fixture.session,synthetic:false,display_name:'Offline verified test member'});
  if(path.includes('live-banking')){banking.push(path);return reply({},503);}
  if(path==='dashboard')return reply({data_version:9,synthetic:false,live_banking_enabled:true,model_policy:'paid_allowed',coverage:'partial_or_unverified',accounts:ids.map((id,i)=>({id,name:`Offline account ${i+1}`,currency:'EUR',account_type:'current',included:true,source:null,access_status:'observed',balance:{amount_minor:10000,kind:'booked',observed_at:'2026-11-13T08:00:00Z',pending_reflection:'unknown'}}))});
  if(path==='ledger/inventory')return reply({scope,total_booked_count:80,period_booked_count:73,period_unresolved_count:73,available_start:period.start,available_end_exclusive:period.end_exclusive});
  if(path==='analysis/tools/execute'){
   const base=analysisTotals({...period,currency:'EUR',account_ids:null,category:null,merchant:null,expected_data_version:null});
   return reply({name:'spending_totals',result:{...base,scope:{...scope,start:request.postDataJSON().arguments.start,end_exclusive:request.postDataJSON().arguments.end_exclusive},gross_minor:0,refunds_minor:0,net_minor:0,expense_count:0,refund_count:0,unresolved_flow_count:73,nonconsumption_count:0,category_baskets:[],merchants:[]}});
  }
  if(path==='ledger/transactions')return reply({scope,rows:url.searchParams.get('cursor')?rows.slice(50):rows.slice(0,50),next_cursor:url.searchParams.get('cursor')?null:'fixture-cursor'});
  if(path==='coach/query'){
   coachCalls++;
   coachBodies.push(request.postDataJSON());
   return reply({read_only:true,persisted:false,card:null,habits:null,transactions:{scope,rows:rows.slice(0,50),next_cursor:'fixture-cursor'},model_usage:{calls:1,input_tokens:100,output_tokens:100,cost_limit_enabled:false},interpretation:{method:'structured_model',resolved_at:'2026-11-13T08:00:00Z',status:'ready',reason:'SUPPORTED_QUERY',message:'Scoped server result',intent:{kind:'analysis',tool:{name:'ledger_transactions',arguments:{...period,currency:'EUR',account_ids:null,category:null,merchant:null,expected_data_version:null,status:'booked',spending_only:false,limit:50,cursor:null}}}}});
  }
  return reply({},404);
 });
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await expect(page.locator('[data-overview-block="categories"]')).toContainText('73');
 await expect(page.locator('[data-chart-total]')).toHaveCount(0);
 await expect(page.getByText('Latest recorded balance',{exact:true})).toBeVisible();
 await expect(page.getByText('No transactions have been imported into your private account yet.')).toHaveCount(0);

 await mkdir('.impeccable/review',{recursive:true});
 for(const scheme of ['light','dark'] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/private-records-overview-${scheme}.png`,fullPage:true,animations:'disabled'});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.getByRole('link',{name:'View all transactions',exact:true}).click();
 await expect(page.locator('[data-ledger-row]')).toHaveCount(50);
 await expect(page.locator('main')).not.toContainText('80');
 await page.getByRole('button',{name:'About these records',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('Imported booked entries: 80');
 await expect(page.getByRole('dialog')).toContainText('Entries in this period: 73');
 await expect(page.getByRole('dialog')).toContainText('not counted as spending');
 await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 // The Overview link preserves its displayed October, rather than widening to all history.
 await page.getByRole('button',{name:'Filters',exact:true}).click();
 await expect(page.getByLabel('From',{exact:true})).toHaveValue('2026-10-01');
 await page.getByRole('button',{name:'Read transactions',exact:true}).click();
 await expect(page.locator('[data-ledger-row]')).toHaveCount(50);
 await page.getByRole('button',{name:'Load next entries',exact:true}).click();
 await expect(page.locator('[data-ledger-row]')).toHaveCount(73);
 await page.evaluate(()=>window.scrollTo(0,0));
 await page.screenshot({path:'.impeccable/review/private-records-history.png',animations:'disabled'});
 await page.getByRole('link',{name:'Coach',exact:true}).click();
 await page.getByLabel('Question (English)',{exact:true}).fill('Show transactions from 2026-08-01 until 2026-11-14');
 await page.getByRole('button',{name:'Read my records',exact:true}).click();
 await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(50);
 await page.getByRole('button',{name:'Load next entries',exact:true}).click();
 await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(73);
 await page.getByLabel('Question (English)',{exact:true}).fill('Aga ainult eelmisel kuul?');
 await page.getByRole('button',{name:'Read my records',exact:true}).click();
 await expect(page.locator('[data-coach-turn]')).toHaveCount(2);
 await page.getByLabel('Question (English)',{exact:true}).fill('Kui palju ma sel perioodil kulutasin?');
 await page.getByRole('button',{name:'Read my records',exact:true}).click();
 await expect(page.locator('[data-coach-turn]')).toHaveCount(3);
 await expect(page.getByText(/AI model; calculations and records from authorized server tools/).first()).toBeVisible();
 await page.screenshot({path:'.impeccable/review/private-records-coach.png',animations:'disabled'});
 await page.setViewportSize({width:1280,height:900});await page.screenshot({path:'.impeccable/review/junction/after-private-coach-desktop.png',fullPage:true,animations:'disabled'});
 expect(coachCalls).toBe(3);
 expect((coachBodies[1] as {account_ids:string[]}).account_ids).toEqual(ids);
 expect((coachBodies[1] as {conversation_context:string}).conversation_context).toContain(period.start);
 expect(banking).toEqual([]);
});
