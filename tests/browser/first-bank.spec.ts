import {test,expect,type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";
import {analysisTotals} from "./analysis-support";

// Every private API and provider request is intercepted. No Auth0 login, bank
// credentials, real customer records, live directory or bank request is used.
async function setup(page:Page,{connected=false,eligible=true,empty=false,limited=false}={}){
 await page.setViewportSize({width:390,height:844});await page.clock.install({time:new Date(fixture.clock)});
 const session={...fixture.session,synthetic:false},id="00000000-0000-0000-0000-000000000711";
 const bank={id,name:"Offline personal bank",country:"EE",mode:"sandbox",consent_state:"active",account_count:1,expires_at:"2026-12-01T00:00:00Z",last_success_at:null as string|null,sync_health:"never_synced",last_error_code:null as string|null,retry_not_before:null as string|null,retry_after_known:false,import_in_progress:false};
 const calls:{path:string;body:unknown}[]=[],accounts=fixture.context.accounts.slice(0,1).map(a=>({id:a.id,name:"Offline test account",currency:"EUR",account_type:"current",included:true,source:null,balance:null,access_status:"no_observation"}));
 let imported=connected,directoryFailed=false;
 const rows=[{id:"00000000-0000-0000-0000-000000000811",account_id:accounts[0].id,amount_minor:-1200,currency:"EUR",booked_on:"2026-10-20",status:"booked",merchant:"Synthetic unreviewed payment",category:"unclassified",basket:"unresolved",economic_flow:"unknown"}];
 await page.route("https://auth.enablebanking.com/ais/first-bank-offline",route=>route.fulfill({contentType:"text/html",body:`<p>Simulated provider consent; no bank contacted.</p><button onclick="location.href='${new URL(`/banks?live_status=connected&connection=${id}`,page.url()).href}'">Approve offline consent</button>`}));
 await page.route("**/api/v1/**",async route=>{
  const req=route.request(),url=new URL(req.url()),path=url.pathname.replace("/api/v1/","");const reply=(json:unknown,status=200)=>route.fulfill({status,json});
  if(path==="auth/session")return reply(session);
  expect(req.headers()["x-moneylens-session-id"]).toBe(session.session_id);
  if(req.method()==="POST")expect(req.headers()["x-csrf-token"]).toBe(session.csrf_token);
  calls.push({path,body:req.method()==="POST"?req.postDataJSON():null});
  if(path==="dashboard")return reply({data_version:7,synthetic:false,accounts:imported?accounts:[],connected_bank_count:connected?1:0,live_banking_enabled:eligible,model_policy:"free_only"});
  if(path==="live-banking/capabilities")return reply({enabled:eligible,environment:"sandbox"});
  if(path==="live-banking/institutions")return directoryFailed?reply({error:{code:"BANK_PROVIDER_UNAVAILABLE"}},503):reply([{name:bank.name,country:url.searchParams.get("country")},{name:"Another offline bank",country:url.searchParams.get("country")}]);
  if(path==="live-banking/connections")return reply(connected?[bank]:[]);
  if(path==="live-banking/connect"){connected=true;return reply({redirect_url:"https://auth.enablebanking.com/ais/first-bank-offline"});}
  if(path.endsWith("/refresh")){
   await new Promise(resolve=>setTimeout(resolve,150));
   if(limited){bank.retry_not_before="2026-11-04T12:00:00Z";bank.last_error_code="bank_aspsp_rate_limit_exceeded";return reply({error:{code:"BANK_IMPORT_WAIT",message:"The bank asked us to wait. Your consent is preserved."}},429);}
   imported=true;bank.last_success_at=fixture.clock;return reply({account_count:1,booked_transactions:empty?0:rows.length,observed_at:fixture.clock,coverage:"partial",notice:"Partial synthetic test history."});
  }
  const period={start:url.searchParams.get("start")??"2026-10-01",end_exclusive:url.searchParams.get("end_exclusive")??"2026-11-01"};
  const totals=analysisTotals({...period,currency:"EUR",account_ids:null,category:null,merchant:null,expected_data_version:null});
  if(path==="analysis/tools/execute")return reply({name:"spending_totals",result:{...totals,gross_minor:0,refunds_minor:0,net_minor:0,expense_count:0,refund_count:0,unresolved_flow_count:empty?0:1,category_baskets:[],category_breakdown_truncated:false}});
  if(path==="ledger/inventory")return reply({scope:totals.scope,total_booked_count:empty?0:1,period_booked_count:empty?0:1,period_unresolved_count:empty?0:1,period_unresolved_gross_minor:0,period_unreviewed_outgoing_minor:empty?0:1200,period_unreviewed_outgoing_count:empty?0:1,available_start:"2026-10-01",available_end_exclusive:"2026-11-01"});
  if(path==="ledger/transactions")return reply({scope:totals.scope,rows:empty?[]:rows,next_cursor:null});
  return reply({error:{code:"NOT_FOUND"}},404);
 });
 return {calls,failDirectory:()=>{directoryFailed=true;},recoverDirectory:()=>{directoryFailed=false;}};
}
async function shot(page:Page,name:string){await mkdir(".cache/first-bank-review",{recursive:true});for(const theme of ["light","dark"] as const){await page.emulateMedia({colorScheme:theme});await page.screenshot({path:`.cache/first-bank-review/${name}-${theme}.png`,animations:"disabled"});}expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}

test("fresh eligible member chooses, consents, imports once and opens transactions",async({page})=>{
 const {calls}=await setup(page);await page.goto("/");
 await expect(page.locator("[data-first-bank]")).toBeVisible();await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(4);
 const primary=page.getByRole("link",{name:"Connect your bank",exact:true}),demo=page.getByRole("link",{name:"Try with demo data",exact:true});
 expect((await primary.boundingBox())!.width).toBe((await demo.boundingBox())!.width);await shot(page,"fresh");
 await primary.click();await expect(page.getByLabel("Country",{exact:true})).toBeVisible();await page.getByLabel("Find your bank").fill("Offline personal");await shot(page,"picker");
 await page.getByRole("button",{name:"Offline personal bank",exact:true}).click();await expect(page.getByText(/approve read-only access/)).toBeVisible();expect(calls.filter(c=>c.path==="live-banking/connect")).toHaveLength(0);await shot(page,"confirm");
 await page.getByRole("button",{name:"Continue to Offline personal bank"}).click();await page.getByRole("button",{name:"Approve offline consent"}).click();await expect(page.getByRole("heading",{name:"Offline personal bank connected"})).toBeVisible();await shot(page,"returned");
 await page.getByRole("button",{name:"Import transactions",exact:true}).dblclick();await expect(page.getByText("Imported transactions: 1",{exact:true})).toBeVisible();expect(calls.filter(c=>c.path.endsWith("/refresh"))).toHaveLength(1);await shot(page,"imported");
 await page.getByRole("link",{name:"View transactions",exact:true}).click();await expect(page.getByText("Synthetic unreviewed payment",{exact:true})).toBeVisible();await shot(page,"transactions");
 await page.getByRole("link",{name:"Overview",exact:true}).click();await expect(page.locator("[data-first-bank]")).toHaveCount(0);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","1200");await expect(page.getByText("Not categorised",{exact:false}).first()).toBeVisible();await expect(page.getByRole("link",{name:/Needs review/})).toBeVisible();await shot(page,"returning");
});
test("returning member keeps normal dashboard and add-bank stays on banks",async({page})=>{
 await setup(page,{connected:true});await page.goto("/");await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","1200");await expect(page.locator("[data-first-bank]")).toHaveCount(0);await expect(page.getByText("Includes outgoing payments awaiting review.",{exact:false})).toBeVisible();await page.goto("/banks");await expect(page.getByRole("button",{name:"Add another bank",exact:true})).toBeVisible();
});
test("cancelled consent stays in picker with no automatic authorization",async({page})=>{
 const {calls}=await setup(page);await page.goto("/banks?live_status=denied");await expect(page.getByText("Connection cancelled. No new bank access was granted.")).toBeVisible();await expect(page.getByLabel("Find your bank")).toBeVisible();expect(calls.filter(c=>c.path==="live-banking/connect"||c.path.endsWith("/refresh"))).toHaveLength(0);await shot(page,"cancelled");
});
test("provider cooldown survives reload and blocks another import",async({page})=>{
 const {calls}=await setup(page,{connected:true,limited:true});await page.goto("/banks?live_status=connected&connection=00000000-0000-0000-0000-000000000711");await page.getByRole("button",{name:"Import transactions",exact:true}).click();await expect(page.locator("main").getByRole("alert")).toContainText("Your consent is preserved");await expect(page.getByRole("button",{name:"Import transactions",exact:true})).toBeDisabled();await page.reload();await expect(page.getByRole("button",{name:"Import transactions",exact:true})).toBeDisabled();await expect(page.getByText(/not given an exact wait time/)).toBeVisible();expect(calls.filter(c=>c.path.endsWith("/refresh"))).toHaveLength(1);await shot(page,"cooldown");
});
test("no transactions is honest and retains connected state",async({page})=>{
 await setup(page,{connected:true,empty:true});await page.goto("/banks?live_status=connected&connection=00000000-0000-0000-0000-000000000711");await page.getByRole("button",{name:"Import transactions",exact:true}).click();await expect(page.getByText(/No booked EUR transactions returned/)).toBeVisible();await expect(page.getByRole("link",{name:"View transactions",exact:true})).toBeVisible();await shot(page,"empty");
});
test("country persists, search handles empty and provider failure in the picker",async({page})=>{
 const control=await setup(page);await page.goto("/banks?connect=1");await page.getByLabel("Country",{exact:true}).selectOption("FI");await page.getByLabel("Find your bank").fill("no matching institution");await expect(page.getByText(/No banks found/)).toBeVisible();await page.reload();await expect(page.getByLabel("Country",{exact:true})).toHaveValue("FI");control.failDirectory();await page.getByLabel("Country",{exact:true}).selectOption("SE");await expect(page.locator("main").getByRole("alert")).toBeVisible();control.recoverDirectory();await page.getByRole("button",{name:"Try again",exact:true}).click();await expect(page.getByRole("button",{name:"Offline personal bank",exact:true})).toBeVisible();
});
test("member without live access rehearses public synthetic banks without changing identity",async({page})=>{
 const {calls}=await setup(page,{eligible:false});let stage="consent";
 await page.route("**/api/demo/**",async route=>{const path=new URL(route.request().url()).pathname;if(path.endsWith("/banks"))return route.fulfill({json:[{id:"s-bank-demo",name:"S-Bank-shaped simulator"},{id:"north-demo",name:"North demo bank (fictional)"}]});const body=route.request().postDataJSON();stage=body.action==="approve"?"connected":body.action==="import"?"imported":"consent";return route.fulfill({json:{state:stage,name:"S-Bank-shaped simulator",token:"offline-simulation-only",booked_transactions:1,transactions:[{reference:"fixture-only",merchant:"Synthetic cafe",amount_minor:-450,booked_on:"2026-10-15"}]}});});
 await page.goto("/banks");await expect(page.getByRole("heading",{name:"Connect a demo bank"})).toBeVisible();await page.getByRole("link",{name:"Connect a demo bank",exact:true}).click();await page.getByRole("button",{name:"S-Bank-shaped simulator",exact:true}).click();await page.getByRole("button",{name:"Approve simulated access",exact:true}).click();await page.getByRole("button",{name:"Import transactions",exact:true}).click();await page.getByRole("button",{name:"View transactions",exact:true}).click();await expect(page.getByText("Synthetic cafe",{exact:true})).toBeVisible();await expect(page.getByText("Simulated · No real bank access")).toBeVisible();expect(calls.map(c=>c.path)).toEqual(["live-banking/capabilities"]);await shot(page,"simulated");
});

test("public bank rehearsal uses the real registered simulator without a private session",async({page})=>{
 await page.setViewportSize({width:390,height:844});const privateCalls:string[]=[];
 await page.route("**/api/v1/**",route=>{privateCalls.push(route.request().url());return route.abort();});
 await page.goto("/demo/banks");await page.getByLabel("Country",{exact:true}).selectOption("FI");await page.getByRole("button",{name:"S-Bank-shaped simulator",exact:true}).click();
 await page.getByRole("button",{name:"Cancel",exact:true}).click();await expect(page.getByText("Connection cancelled. No new bank access was granted.")).toBeVisible();
 await page.getByLabel("Country",{exact:true}).selectOption("EE");await page.getByRole("button",{name:"North demo bank (fictional)",exact:true}).click();
 await page.getByRole("button",{name:"Approve simulated access",exact:true}).click();await page.getByRole("button",{name:"Import transactions",exact:true}).click();await page.getByRole("button",{name:"View transactions",exact:true}).click();
 await expect(page.locator('ul[aria-label="View transactions"] li').first()).toBeVisible();expect(privateCalls).toEqual([]);await shot(page,"public-adapter");
});


test("simulated directory timeout leaves a retry and recovers",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.clock.install();
 let stall=true;
 const pending:import("@playwright/test").Route[]=[];
 await page.route("**/api/demo/banks",route=>{if(stall){pending.push(route);return;}return route.fulfill({json:[{id:"s-bank-demo",name:"S-Bank-shaped simulator"}]});});
 await page.goto("/demo/banks");
 await expect(page.getByRole("status")).toContainText("Loading banks");
 await expect(page.getByRole("link",{name:"Try again",exact:true})).toHaveAttribute("href","/demo/banks");
 await page.clock.fastForward(11000);
 await expect(page.locator("main").getByRole("alert")).toContainText("Banks could not be loaded.");
 await Promise.all(pending.map(route=>route.abort().catch(()=>{})));
 stall=false;
 await page.getByRole("button",{name:"Try again",exact:true}).click();
 await expect(page.getByRole("button",{name:"S-Bank-shaped simulator",exact:true})).toBeVisible();
 await page.clock.resume();
});

test("simulated loading document includes native recovery before JavaScript starts",async({request})=>{
 const response=await request.get("/demo/banks");
 expect(response.ok()).toBeTruthy();
 const html=await response.text();
 expect(html).toContain('href="/demo/banks" class="ml-3 text-brand underline underline-offset-4">Try again</a>');
 expect(html).toContain('href="/demo?dataset=starter"');
});


test("loading retry replaces the simulated request without reloading the document",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 const requests:import("@playwright/test").Route[]=[];
 let documents=0;
 page.on("framenavigated",frame=>{if(frame===page.mainFrame())documents++;});
 await page.route("**/api/demo/banks",route=>{requests.push(route);});
 await page.goto("/demo/banks");
 await expect.poll(()=>requests.length).toBe(1);
 const initialDocuments=documents;
 await page.getByRole("link",{name:"Try again",exact:true}).click();
 await expect.poll(()=>requests.length).toBe(2);
 await requests[1].fulfill({json:[{id:"latest",name:"Latest synthetic bank"}]});
 await expect(page.getByRole("button",{name:"Latest synthetic bank",exact:true})).toBeVisible();
 await requests[0].fulfill({json:[{id:"old",name:"Stale synthetic bank"}]}).catch(()=>{});
 await expect(page.getByRole("button",{name:"Stale synthetic bank",exact:true})).toHaveCount(0);
 expect(documents).toBe(initialDocuments);
});

test("simulated empty and failed directories settle and retry in place",async({page})=>{
 await page.setViewportSize({width:390,height:844});let attempt=0;
 await page.route("**/api/demo/banks",route=>{attempt++;return attempt===1?route.fulfill({status:503,json:{error:{code:"DEMO_UNAVAILABLE"}}}):route.fulfill({json:[]});});
 await page.goto("/demo/banks");
 await expect(page.locator("main").getByRole("alert")).toContainText("Banks could not be loaded.");
 await page.evaluate(()=>{document.body.dataset.sameDocument="yes";});
 await page.getByRole("button",{name:"Try again",exact:true}).click();
 await expect(page.getByRole("status")).toContainText("No banks found.");
 expect(await page.locator("body").getAttribute("data-same-document")).toBe("yes");expect(attempt).toBe(2);
});

test("existing service-worker tab returns from demo with Back and uses the directory result",async({page,context})=>{
 await page.setViewportSize({width:390,height:844});
 let requests=0,settled=0;
 page.on("response",response=>{if(new URL(response.url()).pathname==="/api/demo/banks"&&response.status()===200)settled++;});
 await context.route("**/api/demo/banks",route=>{requests++;return route.fulfill({json:[{id:"return",name:"Returning synthetic bank"}]});});
 await page.goto("/demo/banks");await page.getByRole("button",{name:"Returning synthetic bank",exact:true}).waitFor();
 await page.evaluate(()=>navigator.serviceWorker.ready);
 await page.reload();await page.getByRole("button",{name:"Returning synthetic bank",exact:true}).waitFor();
 await page.getByRole("link",{name:"Try with demo data",exact:true}).click();await page.waitForURL("**/demo?dataset=starter");
 await page.goBack();await expect(page.getByRole("button",{name:"Returning synthetic bank",exact:true})).toBeVisible();
 expect(requests).toBeGreaterThanOrEqual(2);expect(settled).toBe(requests);
 const fresh=await context.newPage();await fresh.goto("/demo/banks");await expect(fresh.getByRole("button",{name:"Returning synthetic bank",exact:true})).toBeVisible();await fresh.close();
 await shot(page,"back-directory");
});

for(const stage of ["capabilities","institutions"]){
 test(`live ${stage} timeout settles and the next manual request succeeds`,async({page})=>{
  await setup(page);let stalled=true;const pending:import("@playwright/test").Route[]=[];
  await page.route(`**/api/v1/live-banking/${stage}*`,route=>{if(stalled){pending.push(route);return;}return route.fulfill({json:stage==="capabilities"?{enabled:true,environment:"sandbox"}:[{name:"Recovered offline bank",country:"EE"}]});});
  await page.goto("/banks?connect=1");await expect.poll(()=>pending.length).toBeGreaterThan(0);
  await page.clock.fastForward(11000);
  await expect(page.locator("main").getByRole("alert")).toContainText("Banks could not be loaded.");
  await Promise.all(pending.map(route=>route.abort().catch(()=>{})));stalled=false;
  await page.getByRole("button",{name:"Try again",exact:true}).click();
  await expect(page.getByRole("button",{name:stage==="capabilities"?"Offline personal bank":"Recovered offline bank",exact:true})).toBeVisible();
  await page.clock.resume();
 });
}

test("live directory access denial gives a sign-in action and no invented bank list",async({page})=>{
 await setup(page);
 await page.route("**/api/v1/live-banking/institutions*",route=>route.fulfill({status:403,json:{error:{code:"FORBIDDEN"}}}));
 await page.goto("/banks?connect=1");
 await expect(page.locator("main").getByRole("alert")).toContainText("Sign in with an account that has Money Coach access");
 await expect(page.getByRole("link",{name:"Sign in with another account",exact:true})).toHaveAttribute("href","/api/v1/auth/login?prompt=login");
 await expect(page.getByRole("button",{name:"Offline personal bank",exact:true})).toHaveCount(0);
 await shot(page,"directory-access");
});

test("signed-out live picker asks for sign-in before any directory request",async({page})=>{
 await page.setViewportSize({width:390,height:844});let directories=0;
 await page.route("**/api/v1/**",route=>{const path=new URL(route.request().url()).pathname;if(path.includes("live-banking"))directories++;return route.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED"}}});});
 await page.goto("/banks?connect=1");
 await expect(page.getByRole("link",{name:"Sign in with your identity provider",exact:true})).toBeVisible();
 expect(directories).toBe(0);
});


test("Back replaces an unfinished simulated directory request",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 let sent=0;const pending:import("@playwright/test").Route[]=[];
 await page.route("**/api/demo/banks",route=>{sent++;if(sent===1){pending.push(route);return;}return route.fulfill({json:[{id:"back",name:"Bank after Back"}]});});
 await page.goto("/demo/banks");await expect.poll(()=>sent).toBe(1);
 await page.getByRole("link",{name:"Try with demo data",exact:true}).click();await page.waitForURL("**/demo?dataset=starter");
 await page.goBack();await expect(page.getByRole("button",{name:"Bank after Back",exact:true})).toBeVisible();
 await Promise.all(pending.map(route=>route.abort().catch(()=>{})));expect(sent).toBe(2);
});

test("successful empty live directory shows the empty state",async({page})=>{
 await setup(page);
 await page.route("**/api/v1/live-banking/institutions*",route=>route.fulfill({json:[]}));
 await page.goto("/banks?connect=1");
 await expect(page.getByRole("status")).toContainText("No banks found.");
 await expect(page.getByRole("status")).not.toContainText("Loading banks");
});


test("directory retry releases busy state after an invalidated simulated selection",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 let selection:import("@playwright/test").Route|undefined;
 await page.route("**/api/demo/banks",route=>route.fulfill({json:[{id:"demo",name:"Selectable demo bank"}]}));
 await page.route("**/api/demo/banks/command",route=>{selection=route;});
 await page.goto("/demo/banks");await page.getByRole("button",{name:"Selectable demo bank",exact:true}).click();
 await expect.poll(()=>Boolean(selection)).toBe(true);
 await page.getByRole("link",{name:"Try again",exact:true}).click();
 await selection!.fulfill({json:{state:"consent",name:"Selectable demo bank",token:"synthetic-only"}});
 await expect(page.getByRole("button",{name:"Selectable demo bank",exact:true})).toBeVisible();
 await expect(page.getByRole("button",{name:"Approve simulated access",exact:true})).toHaveCount(0);
});


test("fictional banks switch countries, normalize search and import a newly registered bank",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 await page.route("**/api/v1/**",route=>route.abort());
 await page.goto("/demo/banks");await page.getByLabel("Country",{exact:true}).selectOption("EE");
 await expect(page.locator('section[aria-label="Choose your bank"] li')).toHaveCount(4);
 await page.getByLabel("Find your bank").fill("jarve demo");
 await expect(page.getByRole("button",{name:"Järve Demo Bank (fictional)",exact:true})).toBeVisible();
 await page.getByLabel("Country",{exact:true}).selectOption("FI");
 await expect(page.getByLabel("Find your bank")).toHaveValue("jarve demo");await expect(page.getByRole("status")).toContainText("No banks found");
 await page.getByLabel("Find your bank").fill("");await expect(page.locator('section[aria-label="Choose your bank"] li')).toHaveCount(4);
 await page.getByRole("button",{name:"Koivu Demo Bank (fictional)",exact:true}).click();
 await expect(page.getByText("Simulated · No real bank access")).toBeVisible();
 await page.getByRole("button",{name:"Approve simulated access",exact:true}).click();await page.getByRole("button",{name:"Import transactions",exact:true}).click();await page.getByRole("button",{name:"View transactions",exact:true}).click();
 await expect(page.locator('ul[aria-label="View transactions"] li').first()).toBeVisible();
 await shot(page,"new-fictional-import");
});

test("live picker reaches entries beyond eighty and retains exact provider consent identity",async({page})=>{
 const {calls}=await setup(page);
 await page.route("**/api/v1/live-banking/institutions*",route=>{const country=new URL(route.request().url()).searchParams.get("country");return route.fulfill({json:[...Array.from({length:95},(_,i)=>({name:`Fixture bank ${String(i).padStart(3,"0")}`,country})),{name:"S-Pankki",country}]});});
 await page.goto("/banks?connect=1");await page.getByLabel("Country",{exact:true}).selectOption("FI");
 await expect(page.getByRole("button",{name:"Fixture bank 094",exact:true})).toHaveCount(0);
 for(let i=0;i<4;i++)await page.getByRole("button",{name:/Show more/}).click();
 await expect(page.getByRole("button",{name:"Fixture bank 094",exact:true})).toBeVisible();
 await page.getByLabel("Find your bank").fill("s pankki");await expect(page.getByRole("button",{name:"S-Pankki",exact:true})).toBeVisible();
 await page.getByLabel("Country",{exact:true}).selectOption("EE");await expect(page.getByLabel("Find your bank")).toHaveValue("s pankki");
 await page.getByLabel("Country",{exact:true}).selectOption("FI");await page.getByRole("button",{name:"S-Pankki",exact:true}).click();
 await shot(page,"spelling-confirmation");
 await page.getByRole("button",{name:"Continue to S-Pankki",exact:true}).click();
 expect(calls.find(call=>call.path==="live-banking/connect")?.body).toEqual({name:"S-Pankki",country:"FI"});
});
