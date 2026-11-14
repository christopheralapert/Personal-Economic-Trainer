import {test,expect} from '@playwright/test';
test.skip(process.env.MONEYLENS_STATEMENT_BROWSER_TEST !== 'true','Requires isolated test API and database');
const csv='TransferWise ID,Date,Amount,Currency,Description\nshared,03-10-2026,-5.00,EUR,Synthetic shop\nshared,03-10-2026,-5.00,EUR,Synthetic shop\n';
test('real API: owner preview, confirm, repeat, history and coach',async({browser})=>{
 const a=await browser.newContext({viewport:{width:390,height:844}});const page=await a.newPage();
 await page.goto('/');const loginA=page.waitForResponse(r=>r.url().endsWith('/auth/demo')&&r.request().method()==='POST');await page.getByRole('button',{name:'Continue as Aino'}).click();expect((await loginA).status()).toBe(200);await page.goto('/banks');
 await page.getByLabel('Choose CSV').setInputFiles({name:'synthetic-wise.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});
 const response=page.waitForResponse(r=>r.url().includes('/statements/wise/preview')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'Preview statement'}).click();const preview=await (await response).json();
 await expect(page.getByText('Wise CSV · EUR · 2 entries')).toBeVisible();await page.screenshot({path:'.cache/wise-statement-preview.png',animations:'disabled'});
 const b=await browser.newContext({viewport:{width:390,height:844}});const other=await b.newPage();await other.goto('/');const loginB=other.waitForResponse(r=>r.url().endsWith('/auth/demo')&&r.request().method()==='POST');await other.getByRole('button',{name:'Continue as Mika'}).click();expect((await loginB).status()).toBe(200);
 const result=await other.evaluate(async(id)=>{const s=await (await fetch('/api/v1/auth/session')).json();return (await fetch('/api/v1/statements/wise/confirm',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':s.csrf_token},body:JSON.stringify({preview_id:id})})).status},preview.id);
 expect(result).toBe(404);
 await page.getByRole('button',{name:'Confirm import'}).click();await expect(page.getByText('2 entries available. Their purpose needs review.')).toBeVisible();
 await page.getByRole('link',{name:'View transactions'}).click();await expect(page.locator('[data-ledger-row]')).toHaveCount(2);await page.reload();await expect(page.locator('[data-ledger-row]')).toHaveCount(2);
 await page.goto('/coach');await page.getByLabel('Question (English)').fill('Show transactions from 2026-10-01 until 2026-11-01');await page.getByRole('button',{name:'Read my records'}).click();await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(2);await expect(page.locator('[data-coach-ledger-row]').first()).toContainText('5,00');await expect(page.locator('[data-coach-ledger-row]').first()).toContainText('2026-10-03');
 await page.goto('/banks');await page.getByLabel('Choose CSV').setInputFiles({name:'synthetic-wise.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await page.getByRole('button',{name:'Preview statement'}).click();await expect(page.getByText('2 entries available. Their purpose needs review.')).toBeVisible();
 await other.goto('/transactions?start=2026-10-01&end=2026-11-01');await expect(other.locator('[data-ledger-row]')).toHaveCount(0);await b.close();await a.close();
});
