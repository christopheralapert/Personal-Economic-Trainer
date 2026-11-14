import {test,expect,type Page} from "@playwright/test";
import type {components} from "../../packages/contracts/api";

type Answer=components["schemas"]["CoachAnswerV1"];
const question="How much did I spend on taxis from 2026-10-01 until 2026-11-01?";
const results=(page:Page)=>page.locator(".coach-results");

test.beforeEach(async({page})=>{
  test.skip(process.env.MONEYLENS_BROWSER_IDENTITY!=="true","Requires the existing local synthetic identity fixtures.");
  await page.goto("/analysis");
  await page.getByRole("button",{name:"Continue as Aino",exact:true}).click();
  await page.getByRole("button",{name:"Ask a question",exact:true}).click();
});

async function read(page:Page,text=question):Promise<Answer> {
  await page.getByLabel("Question (English)",{exact:true}).fill(text);
  const response=page.waitForResponse(value=>value.url().endsWith("/coach/query"));
  await page.getByRole("button",{name:"Read my records",exact:true}).click();
  const actual=await response;expect(actual.status()).toBe(200);
  return actual.json();
}

test("actual questions render localized evidence and planning clarification with responsive captures",async({page})=>{
  const answer=await read(page);
  await expect(page.getByRole("heading",{name:answer.card!.title,exact:true})).toBeFocused();
  for(const row of answer.card!.rows) await expect(results(page).getByText(row.label,{exact:true})).toBeVisible();
  await page.getByText("Question source and scope",{exact:true}).click();
  await expect(results(page)).toContainText("Exact category: taxi");
  await expect(results(page)).toContainText("2026-10-01 until 2026-11-01");
  for(const [width,height,scheme,name,enlarged] of [
    [1440,1000,"light","coach-desktop",false],[360,900,"dark","coach-mobile",false],
    [320,900,"light","coach-narrow",false],[320,900,"light","coach-enlarged",true],
  ] as const) {
    await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:scheme,reducedMotion:"reduce"});
    await page.evaluate(large=>{
      document.documentElement.style.fontSize=large ? "200%" : "";
      if(document.activeElement instanceof HTMLElement) document.activeElement.blur();
      window.scrollTo({top:0,left:0,behavior:"instant"});
    },enlarged);
    await expect.poll(()=>page.evaluate(()=>scrollY)).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});
  await page.getByLabel("Answer card language").selectOption("fi");await expect(results(page)).toHaveCount(0);
  const finnish=await read(page);await expect(results(page).getByRole("heading",{name:finnish.card!.title,exact:true})).toBeVisible();
  await expect(results(page).locator("[lang=fi]")).toContainText("Havaittu nettokulutus");
  const clarify=await read(page,"What kind of spender am I?");
  expect(clarify.interpretation.reason).toBe("PERIOD_REQUIRED");await expect(results(page)).toContainText(clarify.interpretation.message);
  await expect(results(page).locator(".plan-breakdown")).toHaveCount(0);
  await read(page,"What is safe for me to spend this week?");
  await expect(results(page).getByRole("link",{name:"Review your spending plan"})).toHaveAttribute("href","/plan");
  await page.getByRole("button",{name:"Use filters",exact:true}).click();await expect(results(page)).toHaveCount(0);
});

test("editing and stopping discard late answers while service failure requires an explicit retry",async({page})=>{
  const seed=await read(page);
  for(const action of ["edit","stop"] as const) {
    let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
    await page.route("**/api/v1/coach/query",async route=>{await gate;await route.fulfill({json:seed});});
    await page.getByLabel("Question (English)",{exact:true}).fill(question+" ");
    const requested=page.waitForRequest(value=>value.url().endsWith("/coach/query"));
    await page.getByRole("button",{name:"Read my records",exact:true}).click();await requested;
    if(action==="edit") await page.getByLabel("Question (English)",{exact:true}).fill(question);
    else await page.getByRole("button",{name:"Stop waiting",exact:true}).click();
    const received=page.waitForResponse(value=>value.url().endsWith("/coach/query"));release();await received;
    await expect(results(page)).toHaveCount(0);await expect(page.getByRole("button",{name:"Read my records",exact:true})).toBeEnabled();
    await page.unroute("**/api/v1/coach/query");
  }
  await page.route("**/api/v1/coach/query",route=>route.fulfill({status:503,json:{error:{code:"SERVICE_UNAVAILABLE"}}}));
  await page.getByRole("button",{name:"Read my records",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("choose Read my records to retry");await expect(results(page)).toHaveCount(0);
  await page.unroute("**/api/v1/coach/query");await read(page);await expect(results(page)).toBeVisible();
});

test("expired snapshots and private lifecycle changes clear questions and financial DOM",async({page,context})=>{
  await page.clock.install();await read(page);await expect(results(page)).toBeVisible();
  await page.clock.fastForward(61000);await expect(results(page)).toHaveCount(0);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("read has expired");
  await read(page);await expect(results(page)).toBeVisible();
  await context.setOffline(true);await expect(results(page)).toHaveCount(0);await expect(page.getByLabel("Question (English)",{exact:true})).toHaveCount(0);
  await context.setOffline(false);await page.getByRole("button",{name:"Ask a question",exact:true}).click();
  await expect(page.getByLabel("Question (English)",{exact:true})).toHaveValue("");
  await read(page);await page.getByRole("button",{name:"Sign out",exact:true}).click();await expect(results(page)).toHaveCount(0);
  await expect(page.getByLabel("Question (English)",{exact:true})).toHaveCount(0);
});
