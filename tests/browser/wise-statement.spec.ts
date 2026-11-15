import {test,expect,type Page} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';

test.skip(process.env.MONEYLENS_STATEMENT_BROWSER_TEST!=='true','Run through test_wise_browser.py with isolated PostgreSQL and signed test OIDC');
const fixture=(name:string)=>path.join(process.env.MONEYLENS_TEST_STATEMENT_FIXTURES!,name);
const item=(page:Page,name:string)=>page.locator(`[data-statement-file="${name}"]`);
async function identity(page:Page,subject:string){
 await page.route('https://**',route=>route.abort());
 await page.route(/\/api\/v1\/auth\/login(?:\?|$)/,async route=>{const response=await route.fetch({maxRedirects:0});expect(response.status()).toBe(303);const headers=response.headers(),target=headers.location;expect(new URL(target).origin).toBe('https://identity.example');delete headers.location;delete headers['content-length'];headers['content-type']='text/html';await route.fulfill({status:200,headers,body:'<a href="'+target.replaceAll('&','&amp;')+'">Open test issuer</a>'});});
 await page.route('https://identity.example/authorize**',async route=>{const state=new URL(route.request().url()).searchParams.get('state')!;const callback=new URL('/api/v1/auth/callback','http://127.0.0.1:33111');callback.search=new URLSearchParams({code:subject+':'+state,state,iss:'https://identity.example'}).toString();await route.fulfill({contentType:'text/html',body:'<a href="'+callback.href.replaceAll('&','&amp;')+'">Continue with test identity</a>'});});
 await page.goto('/import');await page.getByRole('link',{name:'Open test issuer'}).click();await page.getByRole('link',{name:'Continue with test identity'}).click();
 if(subject!=='wise-browser-unknown')await expect(page).toHaveURL(/\/import$/);
}
async function choose(page:Page,names:string[]){await page.goto('/import');const chooser=page.waitForEvent('filechooser');await page.getByLabel('Choose statements').click();await(await chooser).setFiles(names.map(fixture));if(names.includes('synthetic.qif'))await item(page,'synthetic.qif').getByLabel('QIF date order').selectOption('day_first');}
async function preview(page:Page,names:string[]){await page.getByRole('button',{name:'Preview statements',exact:true}).click();for(const name of names)await expect(item(page,name).getByText(/Statement period:/)).toBeVisible();await expect(page.getByLabel('Choose statements')).toHaveValue('');}
async function newAccount(page:Page,name:string,label:string){await item(page,name).getByLabel('Account',{exact:true}).selectOption('new');await item(page,name).getByLabel('New account name').fill(label);}
async function confirm(page:Page){const response=page.waitForResponse(r=>r.url().endsWith('/statements/wise/confirm')&&r.request().method()==='POST');await page.getByRole('button',{name:'Confirm imports',exact:true}).click();const result=await response;expect(result.status()).toBe(200);return result.json();}
async function coach(page:Page,count:number,account?:string){await page.goto('/coach');if(account)await page.getByLabel('Account scope',{exact:true}).selectOption(account);await page.locator('#coach-question').fill('Show transactions from 2026-10-01 until 2026-11-01');const response=page.waitForResponse(r=>r.url().endsWith('/coach/query')&&r.request().method()==='POST');await page.getByRole('button',{name:'Read my records',exact:true}).click();const r=await response;expect(r.status()).toBe(200);const answer=await r.json();expect(answer.transactions.rows).toHaveLength(count);await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(count);return answer.transactions.rows;}
function expected(rows:{booked_on:string;amount_minor:number}[]){expect(rows.map(r=>[r.booked_on,r.amount_minor]).sort()).toEqual([['2026-10-03',-500],['2026-10-03',-500],['2026-10-15',1250]].sort());}

for(const format of ['csv','pdf','xlsx','xml','mt940','qif'])test(`${format}: file to saved records and Coach, exact repeat`,async({page})=>{
 await identity(page,'wise-browser-'+format);const name='synthetic.'+format;await choose(page,[name]);await preview(page,[name]);
 await expect(item(page,name)).toContainText('3 entries');
 await expect(item(page,name)).toContainText(`Statement period: 2026-10-${['csv','xlsx','qif'].includes(format)?'03':'01'} — 2026-10-${['csv','xlsx','qif'].includes(format)?'15':'31'}`);
 await expect(item(page,name).getByRole('combobox',{name:'Account',exact:true})).toBeVisible();
 if(format!=='qif')await expect(item(page,name)).toContainText('EUR');
 if(format==='csv'||format==='xlsx'||format==='qif')await newAccount(page,name,'Wise '+format);
 if(format==='qif'){await expect(page.getByRole('button',{name:'Confirm imports',exact:true})).toBeDisabled();await item(page,name).getByLabel('Confirm statement currency').selectOption('EUR');}
 await expect(item(page,name).getByRole('combobox',{name:'Account',exact:true})).not.toHaveValue('');
 const saved=await confirm(page);expect(saved.added_count).toBe(3);const account=saved.files[0].account_id;
 await item(page,name).getByRole('link',{name:'View transactions'}).click();await expect(page.locator('[data-ledger-row]')).toHaveCount(3);await page.reload();await expect(page.locator('[data-ledger-row]')).toHaveCount(3);
 expected(await coach(page,3,account));await expect(page.locator('[data-statement-date]')).toContainText(format==='csv'||format==='xlsx'||format==='qif'?'2026-10-15':'2026-10-31');
 if(format==='csv'){
  // A later export has different bytes and encoding; match the chosen account
  // and the complete reference/date/amount/description multiset, preserving repeats.
  await choose(page,['synthetic.pdf','synthetic.xlsx']);await preview(page,['synthetic.pdf','synthetic.xlsx']);
  for(const cross of ['synthetic.pdf','synthetic.xlsx'])await item(page,cross).getByLabel('Account',{exact:true}).selectOption(account);
  expect((await confirm(page)).added_count).toBe(0);expected(await coach(page,3,account));
 }
 await choose(page,[name]);await page.getByRole('button',{name:'Preview statements',exact:true}).click();
 if(format==='csv'||format==='xlsx'||format==='qif'){
  await item(page,name).getByLabel('Account',{exact:true}).selectOption(account);
  if(format==='qif')await item(page,name).getByLabel('Confirm statement currency').selectOption('EUR');
  expect((await confirm(page)).added_count).toBe(0);
 }
 await expect(item(page,name).getByText('Already saved; no entries added.')).toBeVisible();await expect(page.getByRole('button',{name:'Confirm imports',exact:true})).toHaveCount(0);
 expected(await coach(page,3,account));
});

test('mixed files: errors, cross-format repeats, two accounts and owner isolation',async({browser})=>{
 const unknown=await browser.newContext();const denied=await unknown.newPage();await identity(denied,'wise-browser-unknown');await expect(denied).toHaveURL(/\/access$/);expect((await unknown.cookies()).filter(c=>c.name.includes('moneylens_session'))).toHaveLength(0);await unknown.close();
 const a=await browser.newContext({viewport:{width:390,height:844}}),b=await browser.newContext({viewport:{width:1280,height:900}});const page=await a.newPage(),other=await b.newPage();await identity(page,'wise-browser-a');await identity(other,'wise-browser-b');
 await choose(page,['synthetic.csv','synthetic.pdf','synthetic.xlsx','scanned.pdf','unknown.pdf','broken.pdf']);await preview(page,['synthetic.csv','synthetic.pdf','synthetic.xlsx']);
 await expect(item(page,'scanned.pdf').getByRole('alert')).toContainText('no readable text layer');await expect(item(page,'unknown.pdf').getByRole('alert')).toContainText('CSV');await expect(item(page,'broken.pdf').getByRole('alert')).toContainText('CSV');
 for(const bad of ['scanned.pdf','unknown.pdf','broken.pdf'])await page.getByRole('button',{name:'Remove '+bad,exact:true}).click();
 expect(await page.evaluate(async()=>await(await fetch('/api/v1/accounts')).json())).toEqual([]);
 const staged=await page.locator('[data-statement-file]').count();expect(staged).toBe(3);
 for(const name of ['synthetic.csv','synthetic.pdf','synthetic.xlsx'])await newAccount(page,name,'Wise main');
 const saved=await confirm(page);expect(saved.added_count).toBe(3);expect(saved.files.map((f:{added_count:number})=>f.added_count)).toEqual([3,0,0]);const main=saved.files[0].account_id;
 await mkdir('test-results/statement',{recursive:true});await page.screenshot({path:'test-results/statement/mixed-import-mobile.png',fullPage:true,animations:'disabled'});
 const stolen=await other.evaluate(async preview_id=>{const s=await(await fetch('/api/v1/auth/session')).json();return(await fetch('/api/v1/statements/wise/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token,'X-MoneyLens-Session-ID':s.session_id},body:JSON.stringify({previews:[{preview_id}]})})).status;},saved.files[0].id);expect(stolen).toBe(404);
 expect(await coach(other,0)).toEqual([]);
 const foreign=await other.evaluate(async account=>{return(await fetch('/api/v1/ledger/transactions?'+new URLSearchParams({account_id:account,start:'2026-10-01',end_exclusive:'2026-11-01'}))).status;},main);expect(foreign).toBe(404);
 await choose(page,['synthetic.pdf','synthetic.xlsx']);await page.getByRole('button',{name:'Preview statements',exact:true}).click();
 await item(page,'synthetic.xlsx').getByLabel('Account',{exact:true}).selectOption(main);expect((await confirm(page)).added_count).toBe(0);
 for(const name of ['synthetic.pdf','synthetic.xlsx'])await expect(item(page,name)).toContainText('Already saved; no entries added.');expected(await coach(page,3,main));
 await choose(page,['second.xml']);await preview(page,['second.xml']);const second=await confirm(page);expect(second.added_count).toBe(3);const secondId=second.files[0].account_id;expect(secondId).not.toBe(main);
 expected(await coach(page,3,main));expected(await coach(page,3,secondId));await coach(page,6);
 await page.goto('/transactions?start=2026-10-01&end=2026-11-01');await expect(page.locator('[data-ledger-row]')).toHaveCount(6);await expect(page.locator('[data-statement-date]')).toHaveCount(2);
 await page.goto('/transactions?account_id='+main+'&start=2026-10-01&end=2026-11-01');await expect(page.locator('[data-ledger-row]')).toHaveCount(3);
 await page.goto('/');await expect(page.getByRole('combobox',{name:'Accounts',exact:true})).toBeVisible();await page.getByRole('combobox',{name:'Accounts',exact:true}).selectOption(main);await expect(page.locator('[data-statement-date]')).toHaveCount(1);await page.getByRole('combobox',{name:'Accounts',exact:true}).selectOption('');await expect(page.locator('[data-statement-date]')).toHaveCount(2);
 await choose(other,['synthetic.xml']);await preview(other,['synthetic.xml']);expect((await confirm(other)).added_count).toBe(3);expected(await coach(other,3));await other.screenshot({path:'test-results/statement/coach-desktop.png',fullPage:true,animations:'disabled'});
 await a.close();await b.close();
});
