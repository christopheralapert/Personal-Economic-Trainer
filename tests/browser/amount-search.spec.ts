import {test,expect,type Page} from '@playwright/test';
import {en,fi,et} from '../../frontend/coach/src/i18n/dictionaries';

for(const [locale,question] of [['en',"Show last month's taxi rides over EUR 20."],['fi','Näytä viime kuun yli 20 euron taksimatkat.'],['et','Näita eelmise kuu üle 20 € taksosõite']] as const){
 test(`${locale}: actual private-free organizer query retains amount, period and evidence`,async({page},info)=>{
  const copy={en,fi,et}[locale];
  await page.addInitScript(locale=>{localStorage.setItem('money-coach-privacy.v1','true');localStorage.setItem('money-coach-preferences.v1',JSON.stringify({locale,savings:10}));},locale);
  await page.goto('/demo?dataset=organizer1&tab=coach');
  const input=page.getByRole('textbox',{name:copy.questionLabel,exact:true});await input.fill(question);
  const pending=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat');await page.getByRole('button',{name:copy.send,exact:true}).click();const response=await pending;
  expect(response.headers()['x-money-coach-source']).toBe('rule');expect(response.headers()['x-money-coach-evaluation']).toBe('privacy_rule');
  const stream=await response.text();expect(stream).toContain('"amount_min_minor":2001');
  const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer.locator('[data-spoken-answer]')).toContainText('30,97');
  if(locale==='en')for(const width of [390,1280]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath(`amount-search-${width}.png`),fullPage:true,animations:'disabled'});}
  await answer.getByRole('button',{name:'MRC-TRN-0063',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('26.8.2026');await expect(page.getByRole('dialog')).toContainText('30,97');
  await page.getByRole('dialog').getByRole('button',{name:copy.done,exact:true}).click();
  await input.fill('Show transactions taxi under EUR 30.97 last month');const empty=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/chat');await page.getByRole('button',{name:copy.send,exact:true}).click();const emptyStream=await(await empty).text();
  expect(emptyStream).toContain('"total":0');expect(emptyStream).toContain('"amount_max_minor":3096');
  await expect(page.locator('[data-message-role="assistant"]').last().getByRole('button',{name:'MRC-TRN-0063',exact:true})).toHaveCount(0);
 });
}

test('signed test-OIDC: fresh CSV, two accounts, strict bounds, model test transport, Privacy and second owner',async({page,browser})=>{
 test.skip(process.env.MONEYLENS_AMOUNT_SEARCH_PRIVATE!=='true','Requires fresh isolated PostgreSQL/test-OIDC fixture, not real Auth0');
 await page.goto('/api/v1/auth/login?return_to=/import');await page.getByRole('link',{name:'model-review',exact:true}).click();await expect(page.getByLabel('Choose statements',{exact:true})).toBeVisible();
 async function importAccount(label:string,amounts:string[]){
  await page.goto('/import');const name=`synthetic-amount-${label}.csv`;
  const csv='TransferWise ID,Date,Amount,Currency,Description\n'+amounts.map((amount,index)=>`CARD-AMOUNT-${label}-${index},03-10-2026,-${amount},EUR,BOLT *RIDE\n`).join('');
  await page.getByLabel('Choose statements',{exact:true}).setInputFiles({name,mimeType:'text/csv',buffer:Buffer.from(csv)});
  await page.getByRole('button',{name:'Preview statements',exact:true}).click();const item=page.locator(`[data-statement-file="${name}"]`);
  await expect(item.getByRole('combobox',{name:'Category 1',exact:true})).toHaveValue('taxi');
  await item.getByLabel('Account',{exact:true}).selectOption('new');await item.getByLabel('New account name',{exact:true}).fill(`Amount fixture ${label}`);
  const started=performance.now(),pending=page.waitForResponse(r=>r.url().endsWith('/statements/wise/confirm'));
  await page.getByRole('button',{name:'Confirm imports',exact:true}).click();const response=await pending;expect(response.status()).toBe(200);const saved=await response.json();expect(saved.added_count).toBe(amounts.length);
  await item.getByRole('link',{name:'View transactions',exact:true}).click();await expect(page.locator('[data-ledger-row]')).toHaveCount(amounts.length);
  console.log(JSON.stringify({syntheticRows:amounts.length,confirmToHistoryMs:Math.round(performance.now()-started)}));
  await page.reload();await expect(page.locator('[data-ledger-row]')).toHaveCount(amounts.length);return saved.files[0].account_id as string;
 }
 const a=await importAccount('A',['15.00','15.97']),b=await importAccount('B',['7.00']);
 await page.goto('/coach');const account=page.getByRole('combobox',{name:'Account scope',exact:true});
 async function ask(question:string,expected:number,privacy=true){
  const checkbox=page.getByRole('checkbox',{name:'Privacy mode',exact:true});await checkbox.setChecked(privacy);
  await page.locator('#coach-question').fill(question);const started=performance.now(),pending=page.waitForResponse(r=>r.url().endsWith('/coach/query'));
  await page.getByRole('button',{name:'Read my records',exact:true}).click();const response=await pending;expect(response.status()).toBe(200);const body=await response.json();
  expect(body.source).toBe(privacy?'rule':'model');if(!privacy)expect(body.provider).toBe('gemini-direct');
  expect(body.transactions.rows.reduce((sum:number,row:{amount_minor:number})=>sum-row.amount_minor,0)).toBe(expected);
  await expect(page.locator('[data-coach-ledger-row]')).toHaveCount(body.transactions.rows.length);
  console.log(JSON.stringify({questionToVisibleMs:Math.round(performance.now()-started),transport:privacy?'local-privacy':'mocked-native-gemini',matchingRows:body.transactions.rows.length,expectedMinor:expected}));return body;
 }
 await account.selectOption(a);let body=await ask('Show transactions taxi over EUR 15 in October 2026',1597);
 expect(body.transactions.scope.account_ids).toEqual([a]);await page.locator('[data-coach-ledger-row]').last().getByRole('button').click();await expect(page.getByRole('dialog')).toContainText('15,97');await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();
 await ask('Show transactions taxi at least EUR 15 at most EUR 15.97 in October 2026',3097,false);
 await account.selectOption(b);body=await ask('Show transactions taxi over EUR 5 in October 2026',700);expect(body.transactions.scope.account_ids).toEqual([b]);
 await account.selectOption('');body=await ask('Show transactions taxi over EUR 5 in October 2026',3797);expect(body.transactions.scope.account_ids.sort()).toEqual([a,b].sort());
 await account.selectOption(a);await ask('Show transactions taxi over EUR 20 in October 2026',0);
 const other=await browser.newContext({viewport:{width:390,height:844}});try{const second=await other.newPage();await second.goto(new URL('/api/v1/auth/login?return_to=/import',page.url()).href);await second.getByRole('link',{name:'other-owner',exact:true}).click();const accounts=await second.evaluate(async()=>await(await fetch('/api/v1/accounts')).json());expect(accounts).toEqual([]);await second.goto(new URL('/coach',page.url()).href);await expect(second.locator('#coach-question')).toBeEditable();await expect(second.locator('[data-coach-ledger-row]')).toHaveCount(0);}finally{await other.close();}
});
