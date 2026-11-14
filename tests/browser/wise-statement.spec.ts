import {test,expect,type Page} from '@playwright/test';
import {mkdir,readFile} from 'node:fs/promises';

test.skip(process.env.MONEYLENS_STATEMENT_BROWSER_TEST !== 'true','Run through test_wise_browser.py with isolated PostgreSQL and test OIDC');
const csv='TransferWise ID,Date,Amount,Currency,Description\nshared,03-10-2026,-5.00,EUR,Synthetic shop\nshared,03-10-2026,-5.00,EUR,Synthetic shop\n';

async function testIdentity(page:Page,subject:string) {
  // App calls use the real BFF/API. Only the issuer page is simulated.
  // The API verifies signed JWTs, nonce and PKCE through an offline transport.
  await page.route('https://**',route=>route.abort());
  await page.route('**/api/v1/auth/login',async route=>{
    const response=await route.fetch({maxRedirects:0});
    expect(response.status()).toBe(303);
    const headers=response.headers(),target=headers.location;
    expect(new URL(target).origin).toBe('https://identity.example');
    delete headers.location;delete headers['content-length'];headers['content-type']='text/html';
    await route.fulfill({status:200,headers,body:'<a href="'+target.replaceAll('&','&amp;')+'">Open test issuer</a>'});
  });
  await page.route('https://identity.example/authorize**',async route=>{
    const state=new URL(route.request().url()).searchParams.get('state')!;
    const callback=new URL('/api/v1/auth/callback','http://127.0.0.1:33111');
    callback.search=new URLSearchParams({code:subject+':'+state,state,iss:'https://identity.example'}).toString();
    await route.fulfill({contentType:'text/html',body:'<a href="'+callback.href.replaceAll('&','&amp;')+'">Continue with test identity</a>'});
  });
}
async function login(page:Page) {
  await page.goto('/');
  await page.getByRole('link',{name:'Sign in with your identity provider',exact:true}).click();
  await page.getByRole('link',{name:'Open test issuer'}).click();
  await page.getByRole('link',{name:'Continue with test identity'}).click();
}
async function preview(page:Page,openBanks=true,content=csv,status=200) {
  if(openBanks)await page.goto('/banks');
  const chooser=page.waitForEvent('filechooser');
  await page.getByLabel('Choose CSV').click();
  await (await chooser).setFiles({name:'synthetic-wise.csv',mimeType:'text/csv',buffer:Buffer.from(content)});
  const response=page.waitForResponse(r=>r.url().endsWith('/statements/wise/preview')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Preview statement',exact:true}).click();
  const result=await response;expect(result.status()).toBe(status);return result.json();
}
async function confirmAs(page:Page,id:string) {
  return page.evaluate(async preview_id=>{
    const s=await (await fetch('/api/v1/auth/session')).json();
    return (await fetch('/api/v1/statements/wise/confirm',{method:'POST',headers:{'Content-Type':'application/json',
      'X-CSRF-Token':s.csrf_token,'X-MoneyLens-Session-ID':s.session_id},body:JSON.stringify({preview_id})})).status;
  },id);
}
const ready='2 entries available. Their purpose needs review.';
async function seeRows(page:Page) {await expect(page.locator('[data-ledger-row]')).toHaveCount(2);}

test('signed OIDC: CSV persistence, Coach, repeats, overlap, text-PDF rejection and owner isolation',async({browser})=>{
  const unknown=await browser.newContext();const denied=await unknown.newPage();
  await testIdentity(denied,'wise-browser-unknown');await login(denied);
  await expect(denied).toHaveURL(/\/access$/);
  expect((await unknown.cookies()).filter(c=>c.name.includes('moneylens_session'))).toHaveLength(0);
  await unknown.close();

  const a=await browser.newContext({viewport:{width:390,height:844}});let page=await a.newPage();
  await testIdentity(page,'wise-browser-a');await login(page);
  await expect(page.locator('[data-first-bank]')).toBeVisible();
  const staged=await preview(page);
  await expect(page.getByLabel('Choose CSV')).toHaveValue('');
  await expect(page.getByText('Wise CSV · EUR · 2 entries')).toBeVisible();
  await expect(page.getByText('Repeated references are kept as separate entries.')).toBeVisible();
  expect(await page.evaluate(async()=>await (await fetch('/api/v1/accounts')).json())).toEqual([]);
  await mkdir('test-results/statement',{recursive:true});
  await page.screenshot({path:'test-results/statement/wise-preview.png',fullPage:true});

  const b=await browser.newContext({viewport:{width:390,height:844}});const other=await b.newPage();
  await testIdentity(other,'wise-browser-b');await login(other);
  expect(await confirmAs(other,staged.id)).toBe(404);
  await page.getByRole('button',{name:'Confirm import',exact:true}).click();
  await expect(page.getByText(ready)).toBeVisible();
  expect(await confirmAs(page,staged.id)).toBe(200);
  expect(await confirmAs(other,staged.id)).toBe(404);
  expect((await preview(page,false)).state).toBe('published');
  await expect(page.getByText(ready)).toBeVisible();
  await page.getByRole('link',{name:'View transactions',exact:true}).click();await seeRows(page);
  const history=page.url();
  await page.close();page=await a.newPage();await testIdentity(page,'wise-browser-a');await page.goto(history);await seeRows(page);
  await page.reload();await seeRows(page);

  // Different bytes covering the saved period must never append duplicate rows.
  await preview(page,true,csv.replaceAll('shared','another-reference'),409);
  await expect(page.getByRole('alert').filter({hasText:'This period overlaps other Wise records'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toHaveCount(0);
  await page.goto(history);await seeRows(page);

  await page.goto('/coach');
  await page.getByLabel('Question (English)').fill('Show transactions from 2026-10-01 until 2026-11-01');
  const coach=page.waitForResponse(r=>r.url().endsWith('/coach/query')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Read my records',exact:true}).click();
  expect((await coach).status()).toBe(200);
  await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(2);
  for(const text of ['5,00','2026-10-03','Synthetic shop']) await expect(page.locator('[data-coach-ledger-row]').first()).toContainText(text);
  await page.screenshot({path:'test-results/statement/wise-coach.png',fullPage:true});

  expect((await preview(page)).state).toBe('published');
  await expect(page.getByText(ready)).toBeVisible();
  await page.getByRole('link',{name:'View transactions',exact:true}).click();await seeRows(page);
  const foreignLedger=await other.evaluate(async url=>{
    const account=new URL(url).searchParams.get('account_id')!;
    return (await fetch('/api/v1/ledger/transactions?'+new URLSearchParams({account_id:account,start:'2026-10-01',end_exclusive:'2026-11-01'}))).status;
  },history);
  expect(foreignLedger).toBe(404);
  const ownLedger=other.waitForResponse(r=>r.url().includes('/ledger/transactions?'));
  await other.goto('/transactions?start=2026-10-01&end=2026-11-01');
  const empty=await ownLedger;expect(empty.status()).toBe(200);expect((await empty.json()).rows).toEqual([]);
  await expect(other.locator('[data-ledger-row]')).toHaveCount(0);
  await expect(other.getByText('Synthetic shop',{exact:true})).toHaveCount(0);
  await other.goto('/coach');
  await other.getByLabel('Question (English)').fill('Show transactions from 2026-10-01 until 2026-11-01');
  const ownCoach=other.waitForResponse(r=>r.url().endsWith('/coach/query')&&r.request().method()==='POST');
  await other.getByRole('button',{name:'Read my records',exact:true}).click();
  const emptyAnswer=await ownCoach;expect(emptyAnswer.status()).toBe(200);
  expect((await emptyAnswer.json()).transactions.rows).toEqual([]);
  // Identical bytes belong to each owner independently.
  expect((await preview(other)).state).toBe('preview');
  await other.getByRole('button',{name:'Confirm import',exact:true}).click();
  await expect(other.getByText(ready)).toBeVisible();
  await other.getByRole('link',{name:'View transactions',exact:true}).click();await seeRows(other);

  await page.goto('/banks');
  await expect(page.getByLabel('Choose CSV')).toHaveAttribute('accept','.csv,text/csv');
  // The Python fixture verifies this is a readable PDF with a controlled text layer.
  const pdf=await readFile(process.env.MONEYLENS_TEST_STATEMENT_PDF!);
  let pdfSubmitted=false;
  page.on('request',r=>{if(r.url().endsWith('/statements/wise/preview')&&r.method()==='POST')pdfSubmitted=true;});
  await page.getByLabel('Choose CSV').setInputFiles({name:'synthetic.pdf',mimeType:'application/pdf',buffer:pdf});
  await page.getByRole('button',{name:'Preview statement',exact:true}).click();
  await expect(page.getByRole('alert').filter({hasText:'Choose a valid Wise EUR CSV under 64 KiB and try again.'})).toBeVisible();
  expect(pdfSubmitted).toBe(false);
  await expect(page.getByRole('button',{name:'Confirm import',exact:true})).toHaveCount(0);
  await page.goto(history);await seeRows(page);
  await other.reload();await seeRows(other);
  expect(await confirmAs(other,staged.id)).toBe(404);
  await b.close();await a.close();
});
