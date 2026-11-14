import {test,expect,type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";

// Offline UI transport only. These screenshots never imply a bank login succeeded.
async function mockLive(page:Page,enabled=true) {
  await page.clock.install({time:new Date(fixture.clock)});
  const session={...fixture.session,synthetic:false,display_name:"Offline verified test profile"};
  const bank={id:"00000000-0000-0000-0000-000000000111",name:"LHV (offline fixture)",country:"EE",mode:"sandbox",consent_state:"active",account_count:1,expires_at:"2026-12-01T00:00:00Z",last_success_at:null as string|null,sync_health:"never_synced",last_error_code:null,revocation_confirmed:null as boolean|null};
  const calls:string[]=[];
  await page.route("**/api/v1/**",async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.replace('/api/v1/','');
    const respond=(json:unknown,status=200)=>route.fulfill({status,json,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/session")return respond(session);
    expect(req.headers()["x-moneylens-session-id"]).toBe(session.session_id);
    if(req.method()==="POST")expect(req.headers()["x-csrf-token"]).toBe(session.csrf_token);
    calls.push(path);
    if(path==="live-banking/capabilities")return respond({enabled,environment:"sandbox"});
    if(path==="live-banking/institutions")return respond([{name:"LHV (offline fixture)",country:url.searchParams.get("country")},{name:"SEB (offline fixture)",country:url.searchParams.get("country")}]);
    if(path==="live-banking/connections")return respond([bank]);
    if(path.endsWith('/refresh')){bank.last_success_at="2026-11-04T00:00:00Z";bank.sync_health="partial";return respond({account_count:1,booked_transactions:1,observed_at:bank.last_success_at,notice:"All returned balances and imported booked entries were verified as EUR. The bank leaves the account's general currency unspecified. History remains partial."});}
    if(path.endsWith('/data'))return respond({accounts:[{id:"local-account",name:"Offline fixture account",currency:"EUR",included:true,amount_minor:10500,balance_kind:"available",observed_at:"2026-11-04T00:00:00Z"}],transactions:[{id:"local-tx",amount_minor:-450,currency:"EUR",booked_on:"2026-11-01",merchant:"Offline fixture cafe",category:"dining",basket:"everyday",economic_flow:"expense"}]});
    if(path.endsWith('/disconnect')){bank.consent_state="revoked";bank.revocation_confirmed=false;return respond(bank);}
    return respond({error:{code:"NOT_FOUND"}},404);
  });
  await page.goto('/banks');
  await expect(page.getByRole('heading',{name:enabled?'Your banks, securely connected.':'Connect a demo bank'})).toBeVisible();
  return calls;
}

test('verified bank workspace imports, inspects, revokes and distinguishes sandbox; mobile themes',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const calls=await mockLive(page);
  await expect(page.getByText('PROVIDER SANDBOX',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Add another bank',exact:true}).click();
  await page.getByLabel('Find your bank').fill('SEB');
  await expect(page.getByRole('button',{name:'SEB (offline fixture)',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'LHV (offline fixture)',exact:true})).toHaveCount(0);
  await page.goto('/banks');
  await page.getByRole('button',{name:'Import recent transactions'}).click();
  await expect(page.getByRole('status')).toContainText('Imported transactions: 1');
  await expect(page.getByRole('link',{name:'View transactions',exact:true})).toBeVisible();
  await page.goto('/banks');
  await page.getByRole('button',{name:'View imported accounts'}).click();
  await expect(page.getByText('Offline fixture cafe',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Import recent transactions'})).toBeEnabled();
  await mkdir('.impeccable/review',{recursive:true});
  for(const theme of ['light','dark'] as const){
    await page.emulateMedia({colorScheme:theme});
    await page.evaluate(()=>scrollTo(0,0));
    await page.screenshot({path:`.impeccable/review/live-banking-${theme}.png`,fullPage:true,animations:"disabled"});
    await page.screenshot({path:`.impeccable/review/live-banking-${theme}-viewport.png`,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.setViewportSize({width:1280,height:900});
  await page.emulateMedia({colorScheme:'light'});
  await page.evaluate(()=>scrollTo(0,0));
  await page.screenshot({path:'.impeccable/review/live-bank-eur-desktop.png',animations:'disabled'});
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();
  expect(calls.some(path=>path.endsWith('/disconnect'))).toBe(false);
  await page.getByRole('button',{name:'Confirm revoke'}).click();
  await expect(page.locator('.bank-feedback')).toContainText('Provider revocation is unconfirmed');
  await page.getByRole('button',{name:'Past connections',exact:true}).click();
  await expect(page.getByRole('button',{name:'Reconnect',exact:true})).toBeVisible();
  await expect(page.getByText('Offline fixture cafe',{exact:true})).toHaveCount(0);
});

test('disabled banking makes no directory requests and preserves public demo access',async({page})=>{
  const calls=await mockLive(page,false);
  await expect(page.getByRole('heading',{name:'Connect a demo bank'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Try with demo data'})).toHaveAttribute('href','/demo?dataset=organizer1');
  expect(calls).toEqual(['live-banking/capabilities']);
});

test('saved provider wait survives reload and never automatically imports',async({page})=>{
  await mockLive(page);
  let writes=0;
  const bank={id:"00000000-0000-0000-0000-000000000111",name:"Swedbank (offline fixture)",country:"EE",mode:"sandbox",
    consent_state:"active",account_count:2,expires_at:"2026-12-01T00:00:00Z",last_success_at:null,sync_health:"error",
    last_error_code:"bank_aspsp_rate_limit_exceeded",last_error_stage:"transactions",provider_error_code:"ASPSP_RATE_LIMIT_EXCEEDED",
    retry_not_before:"2026-11-04T12:00:00Z",retry_after_known:false,retry_exhausted:false,import_in_progress:false};
  await page.route('**/api/v1/live-banking/connections',route=>route.fulfill({json:[bank]}));
  await page.route('**/api/v1/live-banking/connections/*/refresh',route=>{writes++;return route.fulfill({status:429,json:{error:{code:'BANK_IMPORT_WAIT',message:'Waiting'}}});});
  await page.reload();
  await expect(page.getByText(/Bank limit end unknown/)).toBeVisible();
  await expect(page.getByRole('button',{name:'Import recent transactions'})).toBeDisabled();
  await page.reload();
  await expect(page.getByRole('button',{name:'Import recent transactions'})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Reconnect',exact:true})).toHaveCount(0);
  await mkdir('.impeccable/review',{recursive:true});
  for(const theme of ['light','dark'] as const){
    await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:theme});
    await page.screenshot({path:`.impeccable/review/swedbank-wait-${theme}.png`,fullPage:true,animations:'disabled'});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.setViewportSize({width:1280,height:900});
  await page.screenshot({path:'.impeccable/review/swedbank-wait-desktop.png',fullPage:true,animations:'disabled'});
  expect(writes).toBe(0);
});

test('offline Swedbank directory selection preserves blocked banks and sends only explicit consent',async({page})=>{
  const session={...fixture.session,synthetic:false,display_name:"Offline Swedbank preparation"};
  const writes:{path:string;body:unknown}[]=[];
  const oldBanks=[
    {id:"00000000-0000-0000-0000-000000000211",name:"Wise",last_error_code:"bank_duplicate_source_id"},
    {id:"00000000-0000-0000-0000-000000000212",name:"Luminor",last_error_code:"bank_transaction_id_required"},
  ].map(bank=>({...bank,country:"EE",mode:"live",consent_state:"active",account_count:1,
    expires_at:"2026-12-01T00:00:00Z",last_success_at:null,sync_health:"error",revocation_confirmed:null}));
  await page.route("https://auth.enablebanking.com/ais/offline-swedbank",route=>route.fulfill({
    status:200,contentType:"text/html",body:"<p>Offline consent navigation fixture; no bank contacted.</p>"}));
  await page.route("**/api/v1/**",async route=>{
    const req=route.request();const path=new URL(req.url()).pathname.replace('/api/v1/','');
    const reply=(json:unknown,status=200)=>route.fulfill({status,json,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/session")return reply(session);
    expect(req.headers()["x-moneylens-session-id"]).toBe(session.session_id);
    if(req.method()==="POST"){
      expect(req.headers()["x-csrf-token"]).toBe(session.csrf_token);
      writes.push({path,body:req.postDataJSON()});
    }
    if(path==="live-banking/capabilities")return reply({enabled:true,environment:"production"});
    if(path==="live-banking/institutions")return reply([{name:"Swedbank",country:"EE"},{name:"LHV Pank",country:"EE"}]);
    if(path==="live-banking/connections")return reply(oldBanks);
    if(path==="live-banking/connect")return reply({redirect_url:"https://auth.enablebanking.com/ais/offline-swedbank"});
    return reply({error:{code:"NOT_FOUND"}},404);
  });
  await page.goto('/banks');
  await expect(page.getByText('LIVE',{exact:true})).toBeVisible();
  await expect(page.getByText('Wise ···0211',{exact:true})).toBeVisible();
  await expect(page.getByText('Luminor ···0212',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Wise ···0211',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('bank_duplicate_source_id');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Luminor ···0212',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('bank_transaction_id_required');
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Add another bank',exact:true}).click();
  await page.getByLabel('Find your bank').fill('Swedbank');
  const choice=page.getByRole('button',{name:'Swedbank',exact:true});
  await expect(choice).toBeVisible();
  expect(writes).toEqual([]);
  await choice.click();
  expect(writes).toEqual([]);
  await page.getByRole('button',{name:'Continue to Swedbank',exact:true}).click();
  await expect(page).toHaveURL('https://auth.enablebanking.com/ais/offline-swedbank');
  expect(writes).toEqual([{path:'live-banking/connect',body:{country:'EE',name:'Swedbank'}}]);
});
