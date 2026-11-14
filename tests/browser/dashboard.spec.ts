import {test,expect,type Page} from "@playwright/test";
import {analysisTotals,analysisRows} from "./analysis-support";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";
import type {components} from "../../packages/contracts/api";
type Dashboard=components["schemas"]["DashboardView"];
async function privateProfile(page:Page,accounts:Dashboard["accounts"]=[]) {
  let signedIn=true;
  const calls:{path:string;body:unknown}[]=[];
  const dashboard:Dashboard={data_version:7,synthetic:false,accounts,live_banking_enabled:false,model_policy:"free_only",coverage:"partial_or_unverified"};
  const session={...fixture.session,synthetic:false,display_name:"Private test member"};
  await page.route("**/api/v1/**",async route=>{
    const r=route.request(),path=new URL(r.url()).pathname.replace("/api/v1/","");
    const reply=(json:unknown,status=200)=>route.fulfill({status,json,headers:{"Cache-Control":"private, no-store"}});
    if(!signedIn)return reply({error:{code:"UNAUTHENTICATED"}},401);
    if(path==="auth/session")return reply(session);
    expect(r.headers()["x-moneylens-session-id"]).toBe(session.session_id);
    if(r.method()==="POST")expect(r.headers()["x-csrf-token"]).toBe(session.csrf_token);
    if(path==="auth/logout"){signedIn=false;return route.fulfill({status:204});}
    if(path==="dashboard")return reply(dashboard);
    if(path==="ledger/inventory"){const q=new URL(r.url()).searchParams,totals=analysisTotals({start:q.get("start")!,end_exclusive:q.get("end_exclusive")!,currency:"EUR",account_ids:null,category:null,merchant:null,expected_data_version:null});return reply({scope:totals.scope,total_booked_count:analysisRows.length,period_booked_count:totals.expense_count+totals.refund_count,period_unresolved_count:0,available_start:"2026-09-01",available_end_exclusive:"2026-11-05"});}
    if(path==="analysis/tools/execute")return reply({name:"spending_totals",result:analysisTotals(r.postDataJSON().arguments)});
    if(path.startsWith("ledger/transactions")){const q=new URL(r.url()).searchParams;const totals=analysisTotals({start:q.get("start")!,end_exclusive:q.get("end_exclusive")!,currency:"EUR",account_ids:null,merchant:null,category:q.get("category"),expected_data_version:null});return reply({scope:totals.scope,rows:analysisRows.filter(row=>row.booked_on>=totals.scope.start&&row.booked_on<totals.scope.end_exclusive&&(!q.get("category")||row.category===q.get("category"))),next_cursor:null});}
    if(path.endsWith("/inclusion")){
      const body=r.postDataJSON();calls.push({path,body});
      expect(body.expected_data_version).toBe(dashboard.data_version);
      dashboard.accounts[0].included=body.included;dashboard.accounts[0].balance=null;dashboard.data_version++;
      return reply(dashboard);
    }
    return reply({error:{code:"NOT_FOUND"}},404);
  });
  return calls;
}
test("private homepage has honest empty data, direct tools, and clears on logout",async({page})=>{
  await privateProfile(page);await page.goto("/");
  await expect(page.getByRole("heading",{name:"Connect your bank"})).toBeVisible();
  await expect(page.getByText("See your transactions and ask the Coach about your spending")).toBeVisible();
  await expect(page.getByRole("link",{name:"Try with demo data",exact:true})).toHaveAttribute("href","/demo?dataset=organizer1");
  await expect(page.getByText("Demo household",{exact:true})).toHaveCount(0);
  await expect(page.getByRole("navigation",{name:"Main navigation"}).getByRole("link")).toHaveCount(4);
  await expect(page.locator("[data-first-bank]")).toHaveCount(1);
  await expect(page.locator("[data-overview-block]")).toHaveCount(0);
  await expect(page.locator(".sidebar")).toHaveCount(0);
  for(const width of [1440,390,360]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole("link",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Your plan, your profile."})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Your accounts",exact:true})).toHaveCount(0);
});
test("data controls send owned versioned inclusion writes and never authorize a bank",async({page})=>{
  const calls=await privateProfile(page,[{id:"00000000-0000-0000-0000-000000000101",name:"Owned account",currency:"EUR",account_type:"current",included:true,source:null,balance:null,access_status:"no_observation"}]);
  await page.goto("/settings");await page.getByRole("checkbox",{name:/Owned account/}).click();
  await expect.poll(()=>calls.length).toBe(1);
  expect(calls[0]).toEqual({path:"accounts/00000000-0000-0000-0000-000000000101/inclusion",body:{included:false,expected_data_version:7}});
  await expect(page.getByRole("checkbox",{name:/Owned account/})).not.toBeChecked();
  await expect(page.getByText("Outbound model calls blocked",{exact:true})).toBeVisible();
});
test("coach and what-if have dedicated routes instead of coaching notices or plan review",async({page})=>{
  await privateProfile(page);await page.goto("/coach");
  await expect(page.getByRole("heading",{name:"Coach",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"How much did I spend on taxis last month?",exact:true}).click();
  await expect(page.getByRole("textbox",{name:"Question (English)"})).toHaveValue("How much did I spend on taxis last month?");
  await page.goto("/scenarios");await expect(page.getByRole("heading",{name:"What if",exact:true})).toBeVisible();
  await expect(page.getByRole("slider",{name:"Reduce selected spending by"})).toHaveAttribute("aria-valuenow","20");
});

test("the original category ring and sheet read the selected month from owned APIs",async({page})=>{
  await page.clock.install({time:new Date(fixture.clock)});
  await page.setViewportSize({width:390,height:844});
  await privateProfile(page,[{id:"00000000-0000-0000-0000-000000000001",name:"Offline transport account",currency:"EUR",account_type:"current",included:true,balance:null,source:null,access_status:"no_observation"}]);
  await page.goto("/");
  const totals=analysisTotals({start:"2026-10-01",end_exclusive:"2026-11-01",currency:"EUR",account_ids:null,category:null,merchant:null,expected_data_version:null});
  await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total",String(totals.net_minor));
  await page.locator('[data-overview-block="categories"] button').first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator("li")).not.toHaveCount(0);
  await page.getByRole("button",{name:"Done",exact:true}).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  for(const scheme of ["light","dark"] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/restored-private-ring-${scheme}.png`,fullPage:true,animations:"disabled"});}
  await page.getByRole("button",{name:"Previous month",exact:true}).click();
  await expect(page.getByRole("heading",{name:"September 2026"})).toBeVisible();
  const september=analysisTotals({start:"2026-09-01",end_exclusive:"2026-10-01",currency:"EUR",account_ids:null,category:null,merchant:null,expected_data_version:null});
  await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total",String(september.net_minor));
  expect(september.net_minor).not.toBe(totals.net_minor);
  await page.getByRole("button",{name:"Next month",exact:true}).click();
  await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total",String(totals.net_minor));
});

test("the public Money Coach demo streams only local rule tools",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.goto("/demo?dataset=starter");
  await expect(page.getByRole("heading",{name:"Money Coach",exact:true})).toBeVisible();
  await expect(page.locator("header")).toContainText("Synthetic");
  for(const scheme of ["light","dark"] as const){await page.emulateMedia({colorScheme:scheme});await page.screenshot({path:`.impeccable/review/restored-original-demo-${scheme}.png`,fullPage:true,animations:"disabled"});}
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/chat");
  await page.locator("#home-question").fill("How much did I spend on taxis last month?");
  await page.locator("#home-question").press("Enter");
  const actual=await response;expect(actual.status()).toBe(200);expect(actual.headers()["x-money-coach-source"]).toBe("rule");
  await expect(page.locator("main")).toContainText("40,00");
});


test("overview account switch scopes totals, inventory and transaction previews",async({page})=>{
  await page.setViewportSize({width:390,height:844});
  const account=(id:string,name:string)=>({id,name,currency:"EUR" as const,account_type:"current" as const,included:true,balance:null,source:null,access_status:"no_observation" as const});
  const first="00000000-0000-0000-0000-000000000101",second="00000000-0000-0000-0000-000000000102";
  await privateProfile(page,[account(first,"Offline account one"),account(second,"Offline account two")]);
  const scoped:{path:string;selected:string[]}[]=[];
  page.on("request",r=>{const url=new URL(r.url());if(url.pathname.endsWith("/analysis/tools/execute")&&r.method()==="POST")scoped.push({path:"totals",selected:r.postDataJSON().arguments.account_ids??[]});
    else if(url.pathname.endsWith("/ledger/inventory"))scoped.push({path:"inventory",selected:url.searchParams.getAll("account_id")});
    else if(url.pathname.endsWith("/ledger/transactions"))scoped.push({path:"transactions",selected:url.searchParams.getAll("account_id")});});
  await page.goto("/");await page.getByLabel("Accounts",{exact:true}).selectOption(second);
  await expect.poll(()=>new Set(scoped.filter(call=>call.selected.includes(second)).map(call=>call.path)).size).toBe(3);
  for(const call of scoped.filter(call=>call.selected.includes(second)))expect(call.selected).toEqual([second]);
});
