import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import fixture from "../../fixtures/synthetic/coaching-ui.v1.json";
import {mockCoaching,showCoachingPreferences,signInCoaching} from "./coaching-support";

const bill=fixture.records.find(record=>record.candidate.kind==="upcoming_bill")!;
const headroom=fixture.records.find(record=>record.candidate.kind==="low_headroom")!;

test("coaching starts off and saves explicit kind and quiet-hour preferences without generating notices",async({page})=>{
  const state=await mockCoaching(page);await signInCoaching(page);await showCoachingPreferences(page);
  await expect(page.getByRole("checkbox",{name:"Enable coaching notices",exact:true})).not.toBeChecked();
  await expect(page.getByRole("button",{name:"Refresh notices",exact:true})).toBeDisabled();
  await page.getByRole("checkbox",{name:"Enable coaching notices",exact:true}).check();
  await page.getByRole("checkbox",{name:"Higher observed spending",exact:true}).uncheck();
  await page.getByRole("checkbox",{name:"Set quiet hours",exact:true}).check();
  await page.getByLabel("Quiet hours start",{exact:true}).fill("22:00");
  await page.getByLabel("Quiet hours end",{exact:true}).fill("07:00");
  await page.getByLabel("Time zone",{exact:true}).fill("Europe/Helsinki");
  await page.getByRole("button",{name:"Save preferences",exact:true}).click();
  await expect.poll(()=>state.calls.length).toBe(1);
  expect(state.calls[0]).toMatchObject({path:"coaching/preferences",body:{coaching_enabled:true,bill_insights:true,
    headroom_insights:true,spending_insights:false,quiet_start:"22:00",quiet_end:"07:00",timezone:"Europe/Helsinki",
    paused_until:null,delivery_mode:"in_app_only",expected_preferences_version:1}});
  expect(Object.keys(state.calls[0].body).sort()).toEqual(["bill_insights","coaching_enabled","delivery_mode","expected_preferences_version",
    "headroom_insights","key","paused_until","quiet_end","quiet_start","spending_insights","timezone"].sort());
  await expect(page.getByRole("button",{name:"Refresh notices",exact:true})).toBeEnabled();
  expect(state.records).toHaveLength(0);expect(state.preferences.state.quiet_now).toBe(true);
  expect(state.calls.some(call=>call.path==="insights/refresh")).toBe(false);
});

test("pause and resume use the verified server clock and optimistic preferences version",async({page})=>{
  const state=await mockCoaching(page,{enabled:true});await signInCoaching(page);await showCoachingPreferences(page);
  await page.getByRole("button",{name:"Pause for 24 hours",exact:true}).click();
  await expect.poll(()=>state.calls.length).toBe(1);
  expect(state.calls[0].body).toMatchObject({expected_preferences_version:2,paused_until:new Date(Date.parse(fixture.clock)+86400000).toISOString()});
  await showCoachingPreferences(page);await page.getByRole("button",{name:"Resume coaching",exact:true}).click();
  await expect.poll(()=>state.calls.length).toBe(2);
  expect(state.calls[1].body).toMatchObject({expected_preferences_version:3,paused_until:null,coaching_enabled:true});
  expect(state.preferences.state.paused).toBe(false);expect(state.reads.filter(path=>path==="coaching/preferences").length).toBeGreaterThanOrEqual(5);
});

test("invalid quiet-hour pairs and unknown time zones never send preference commands",async({page})=>{
  const state=await mockCoaching(page);await signInCoaching(page);await showCoachingPreferences(page);
  await page.getByRole("checkbox",{name:"Set quiet hours",exact:true}).check();
  await page.getByLabel("Quiet hours start",{exact:true}).fill("22:00");await page.getByLabel("Quiet hours end",{exact:true}).fill("22:00");
  await page.getByRole("button",{name:"Save preferences",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("two different quiet-hour times");
  await page.getByLabel("Quiet hours end",{exact:true}).fill("07:00");await page.getByLabel("Time zone",{exact:true}).fill("Unknown/Place");
  await page.getByRole("button",{name:"Save preferences",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("IANA time zone");expect(state.calls).toHaveLength(0);
});

test("stored notices expose recorded source evidence and dismissal remains separate from the plan",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await expect(page.locator(".insight-detail h2")).toHaveText(bill.candidate.title);
  await expect(page.locator(".insight-detail")).toContainText("350,00");
  await expect(page.locator(".insight-detail")).toContainText(/source check passed when loaded/i);
  await expect(page.locator(".insight-detail")).toContainText("recorded");
  await expect(page.locator(".insight-detail").getByRole("link",{name:/plan/i})).toHaveAttribute("href","/plan");
  await page.getByRole("button",{name:"Dismiss notice",exact:true}).click();
  await expect.poll(()=>state.calls.length).toBe(1);
  expect(state.calls[0]).toMatchObject({path:`insights/${bill.id}/dismiss`,body:{expected_insight_version:1}});
  await expect(page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true})).toHaveCount(0);
  await page.getByRole("combobox",{name:"Show notices",exact:true}).selectOption("dismissed");
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await expect(page.locator(".insight-detail")).toContainText("Needs a fresh review");
  await expect(page.getByRole("button",{name:"Dismiss notice",exact:true})).toBeDisabled();
  expect(state.calls.every(call=>!call.path.startsWith("plans/"))).toBe(true);
});

test("an expired active record stays readable as historical evidence without current guidance",async({page})=>{
  await mockCoaching(page,{enabled:true,notices:true,stale:true});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${headroom.candidate.title}`,exact:true}).click();
  await expect(page.locator(".insight-detail")).toContainText("Needs a fresh review");
  await expect(page.locator(".insight-detail")).toContainText("50,00");
  await expect(page.locator(".insight-detail")).not.toContainText(/source check passed when loaded/i);
});

test("an open source check expires locally without another financial read or automatic write",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await expect(page.locator(".insight-detail")).toContainText(/source check passed when loaded/i);
  const before=state.reads.filter(path=>path.startsWith("insights")).length;
  await page.clock.fastForward(300100);
  await expect(page.locator(".insight-detail")).toContainText("Needs a fresh review");
  await expect(page.locator(".insight-detail")).not.toContainText(/source check passed when loaded/i);
  expect(state.calls).toHaveLength(0);expect(state.reads.filter(path=>path.startsWith("insights")).length).toBe(before);
});

test("spending notice preserves its two historical windows instead of presenting a future allowance",async({page})=>{
  await mockCoaching(page,{enabled:true,notices:true});await signInCoaching(page);
  await page.getByRole("button",{name:"Review Higher observed spending",exact:true}).click();
  await page.getByText("Recorded sources and calculation details",{exact:true}).click();
  const detail=page.locator(".insight-detail");
  await expect(detail).toContainText("125,00");await expect(detail).toContainText("100,00");
  await expect(detail).toContainText("1 Oct 2026 to 1 Nov 2026 (end excluded)");
  await expect(detail).toContainText("31 Aug 2026 to 1 Oct 2026 (end excluded)");
  await expect(detail).toContainText("not a forecast");
});

test("opting out leaves owned historical notices available while refresh stays disabled",async({page})=>{
  await mockCoaching(page,{notices:true});await signInCoaching(page);
  await expect(page.getByRole("button",{name:"Refresh notices",exact:true})).toBeDisabled();
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await expect(page.locator(".insight-detail")).toContainText("Needs a fresh review");
  await page.getByText("Recorded sources and calculation details",{exact:true}).click();
  await expect(page.locator(".insight-detail")).toContainText("350,00");
});

test("refresh waits for the owned job before showing generated notices",async({page})=>{
  const state=await mockCoaching(page,{enabled:true});await signInCoaching(page);
  await page.getByRole("button",{name:"Refresh notices",exact:true}).click();
  await expect.poll(()=>state.jobReads).toBeGreaterThanOrEqual(1);
  expect(state.records).toHaveLength(0);
  await page.clock.runFor(3500);
  await expect(page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true})).toBeVisible();
  expect(state.jobReads).toBeGreaterThanOrEqual(2);
  expect(state.calls).toHaveLength(1);expect(state.calls[0].path).toBe("insights/refresh");
  expect(Object.keys(state.calls[0].body)).toEqual(["key"]);
});

test("failed refresh remains a failed job and does not invent generated notices",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,jobFails:true});await signInCoaching(page);
  await page.getByRole("button",{name:"Refresh notices",exact:true}).click();
  await expect.poll(()=>state.jobReads).toBeGreaterThanOrEqual(1);
  await page.clock.runFor(3500);
  await expect(page.getByText("The refresh did not complete.",{exact:false})).toBeVisible();
  expect(state.records).toHaveLength(0);expect(state.calls).toHaveLength(1);
});

test("reloading during a pending job status check keeps an explicit recovery action for that same job",async({page})=>{
  const state=await mockCoaching(page,{enabled:true});await signInCoaching(page);
  let intercepted=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v1/jobs/*",async route=>{if(!intercepted) {intercepted=true;await gate;}await route.fallback();});
  await page.getByRole("button",{name:"Refresh notices",exact:true}).click();
  await expect(page.getByText("Refresh queued.",{exact:false})).toBeVisible();await page.clock.runFor(3100);
  await expect.poll(()=>intercepted).toBe(true);
  await page.getByRole("button",{name:"Reload coaching",exact:true}).click();
  await expect(page.getByRole("combobox",{name:"Show notices",exact:true})).toBeVisible();
  const response=page.waitForResponse(value=>value.url().endsWith(`/jobs/${fixture.job.id}`));release();await response;
  await page.getByRole("button",{name:"Check refresh status",exact:true}).click();
  await expect(page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true})).toBeVisible();
  expect(state.calls).toHaveLength(1);expect(state.calls[0].path).toBe("insights/refresh");expect(state.jobReads).toBeGreaterThanOrEqual(2);
});

test("an uncertain preference write locks every write and retries the exact frozen command",async({page})=>{
  const state=await mockCoaching(page,{failOnce:"preferences"});await signInCoaching(page);await showCoachingPreferences(page);
  await page.getByRole("checkbox",{name:"Enable coaching notices",exact:true}).check();
  await page.getByRole("button",{name:"Save preferences",exact:true}).click();
  const retry=page.getByRole("button",{name:"Retry the same coaching request",exact:true});await expect(retry).toBeVisible();
  await expect(page.getByRole("button",{name:"Refresh notices",exact:true})).toBeDisabled();
  await page.clock.fastForward(20000);expect(state.calls).toHaveLength(1);
  await retry.click();await expect(retry).toHaveCount(0);
  expect(state.calls).toHaveLength(2);expect(state.calls[0]).toEqual(state.calls[1]);expect(state.preferences.version).toBe(2);
});

test("an uncertain dismissal hides the old detail and replays one owned action",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true,failOnce:"dismiss"});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await page.getByRole("button",{name:"Dismiss notice",exact:true}).click();
  const retry=page.getByRole("button",{name:"Retry the same coaching request",exact:true});await expect(retry).toBeVisible();
  await expect(page.locator(".insight-detail")).toHaveCount(0);await retry.click();await expect(retry).toHaveCount(0);
  expect(state.calls).toHaveLength(2);expect(state.calls[0]).toEqual(state.calls[1]);
  expect(state.records.filter(record=>record.status==="dismissed")).toHaveLength(1);
});

test("a version conflict clears the detail and offers a reload without replay",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true,conflict:true});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await page.getByRole("button",{name:"Dismiss notice",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Reload coaching");
  await expect(page.locator(".insight-detail")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Retry the same coaching request",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Reload coaching",exact:true}).click();expect(state.calls).toHaveLength(1);
});

test("offline and hidden-page transitions clear private notices and drafts without queuing writes",async({page,context})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true});await signInCoaching(page);await showCoachingPreferences(page);
  await page.getByLabel("Time zone",{exact:true}).fill("Private/draft");
  await context.setOffline(true);await expect(page.getByText("You're offline.",{exact:false})).toBeVisible();
  await expect(page.locator(".insight-detail")).toHaveCount(0);await expect(page.getByRole("textbox")).toHaveCount(0);
  await context.setOffline(false);await expect(page.getByRole("heading",{name:"Your coaching notices",exact:true})).toBeVisible();
  await showCoachingPreferences(page);await expect(page.getByLabel("Time zone",{exact:true})).toHaveValue("Europe/Helsinki");
  await page.getByLabel("Time zone",{exact:true}).fill("Private/background");
  await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});document.dispatchEvent(new Event("visibilitychange"));});
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await page.evaluate(()=>{Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"});document.dispatchEvent(new Event("visibilitychange"));});
  await expect(page.getByRole("heading",{name:"Your coaching notices",exact:true})).toBeVisible();
  await showCoachingPreferences(page);await expect(page.getByLabel("Time zone",{exact:true})).toHaveValue("Europe/Helsinki");
  expect(state.calls).toHaveLength(0);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toMatch(/Private\/|Upcoming reviewed bill/);
});

test("history pagination appends bounded summaries without losing the selected filter",async({page})=>{
  const state=await mockCoaching(page,{enabled:true,notices:true,pagination:true});await signInCoaching(page);
  await expect(page.getByRole("button",{name:/^Review /})).toHaveCount(2);
  await page.getByRole("button",{name:"Load more notices",exact:true}).click();
  await expect(page.getByRole("button",{name:/^Review /})).toHaveCount(3);
  expect(state.reads.some(path=>path.includes("cursor=ui-only-page-2")&&path.includes("status=active"))).toBe(true);
});

test("unavailable coaching history offers recovery and never invents an empty owned history",async({page})=>{
  await mockCoaching(page,{enabled:true,unavailable:true});await signInCoaching(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Coaching history is unavailable");
  await expect(page.getByRole("button",{name:"Reload coaching",exact:true})).toBeEnabled();
});

test("coaching notice evidence and preference controls fit mobile dark mode and enlarged text",async({page})=>{
  await mockCoaching(page,{enabled:true,notices:true});await signInCoaching(page);
  await page.getByRole("button",{name:`Review ${bill.candidate.title}`,exact:true}).click();
  await page.getByText("Recorded sources and calculation details",{exact:true}).click();
  if(process.env.MONEYLENS_CAPTURE_COACHING==="true") await mkdir(".impeccable/review",{recursive:true});
  for(const [width,theme,name] of [[1440,"light","coaching-desktop"],[390,"dark","coaching-mobile"],[320,"light","coaching-enlarged"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    if(name==="coaching-enlarged") await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.MONEYLENS_CAPTURE_COACHING==="true") await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
  }
  if(process.env.MONEYLENS_CAPTURE_COACHING==="true") {
    await page.setViewportSize({width:390,height:1000});await page.emulateMedia({colorScheme:"light"});
    await page.evaluate(()=>{document.documentElement.style.fontSize="";});await showCoachingPreferences(page);
    await page.getByRole("checkbox",{name:"Set quiet hours",exact:true}).check();
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:".impeccable/review/coaching-preferences.png",fullPage:true,animations:"disabled"});
  }
});
