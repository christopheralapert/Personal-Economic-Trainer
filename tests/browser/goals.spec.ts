import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {mockGoals,signInGoals} from "./goal-support";

async function fillGoal(page:import("@playwright/test").Page) {
  await page.getByRole("button",{name:"Add a goal",exact:true}).click();
  await page.getByRole("textbox",{name:"Goal name",exact:true}).fill("Emergency fund");
  await page.getByRole("textbox",{name:"Target (EUR)",exact:true}).fill("100,00");
  await page.getByLabel("Deadline",{exact:true}).fill("2026-12-31");
}

test("goal lifecycle separates intentions reservations and unknown actual saved money",async({page})=>{
  const state=await mockGoals(page);await signInGoals(page);
  await expect(page.getByText("No savings goal yet.",{exact:false})).toBeVisible();
  await fillGoal(page);await page.getByRole("button",{name:"Create goal",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Emergency fund",exact:true,level:2})).toBeFocused();
  await expect(page.locator(".goal-detail")).toContainText("Not yet verified");
  expect(state.calls[0].body).toMatchObject({target_minor:10000,currency:"EUR"});
  expect(Object.keys(state.calls[0].body).sort()).toEqual(["currency","deadline","key","name","priority","target_minor"]);
  await page.getByRole("button",{name:"Pause goal",exact:true}).click();
  await expect(page.getByRole("button",{name:"Activate goal",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Activate goal",exact:true}).click();
  await page.getByRole("button",{name:"Edit goal",exact:true}).click();
  await page.getByRole("textbox",{name:"Goal name",exact:true}).fill("Rainy day fund");await page.getByRole("button",{name:"Save goal changes"}).click();
  await expect(page.getByRole("heading",{name:"Rainy day fund",exact:true,level:2})).toBeFocused();
  await page.getByRole("button",{name:"Remove goal",exact:true}).click();
  expect(state.calls.some(call=>call.path.endsWith("/remove"))).toBe(false);
  await page.getByRole("button",{name:"Confirm remove goal"}).click();
  await expect(page.locator(".goal-list")).toHaveCount(0);
  await page.getByRole("combobox",{name:"Show goals"}).selectOption("removed");
  await expect(page.getByRole("button",{name:"Review Rainy day fund"})).toBeVisible();
});

test("existing reservation linking and explicit unlink keep the original money receipt",async({page})=>{
  const state=await mockGoals(page,{initial:"empty"});await signInGoals(page);
  await page.getByRole("button",{name:"Review Emergency fund"}).click();
  await page.getByRole("button",{name:"Load current plan reservations"}).click();
  await page.getByRole("combobox",{name:"Reservation to link"}).selectOption({index:1});
  await page.getByRole("button",{name:"Link existing reservation",exact:true}).click();
  await expect(page.locator(".goal-detail .reservation-list")).toContainText("Reserved");
  await expect(page.locator(".goal-detail .plan-breakdown")).toContainText("50,00");
  await page.getByRole("button",{name:"Remove goal",exact:true}).click();
  await expect(page.getByRole("button",{name:"Confirm remove goal"})).toBeDisabled();
  await page.getByRole("button",{name:"Keep money reserved; unlink",exact:true}).click();
  await expect(page.getByText("No reservation is currently linked to this goal.")).toBeVisible();
  expect(state.calls.at(-1)?.body.reservation_choice).toBe("keep_reserved");
  expect(state.calls.every(call=>!call.path.startsWith("plans/"))).toBe(true);
});

test("uncertain goal response locks writes and manual retry reuses the exact command",async({page})=>{
  const state=await mockGoals(page,{failOnce:true});await signInGoals(page);await fillGoal(page);
  await page.getByRole("button",{name:"Create goal",exact:true}).click();
  const retry=page.getByRole("button",{name:"Retry the same goal request"});await expect(retry).toBeVisible();
  await expect(page.getByRole("button",{name:"Add a goal",exact:true})).toBeDisabled();
  await expect(page.locator(".goal-detail")).toHaveCount(0);await page.clock.fastForward(20000);expect(state.calls).toHaveLength(1);
  await retry.click();await expect(page.getByRole("heading",{name:"Emergency fund",exact:true,level:2})).toBeVisible();
  expect(state.calls).toHaveLength(2);expect(state.calls[0]).toEqual(state.calls[1]);expect(state.goals).toHaveLength(1);
});

test("version conflict hides stale progress and asks for a fresh read",async({page})=>{
  const state=await mockGoals(page,{initial:"empty",conflict:true});await signInGoals(page);
  await page.getByRole("button",{name:"Review Emergency fund"}).click();await page.getByRole("button",{name:"Pause goal",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Reload goals");
  await expect(page.locator(".goal-detail")).toHaveCount(0);await expect(page.getByRole("button",{name:"Retry the same goal request"})).toHaveCount(0);
  await page.getByRole("button",{name:"Reload goals",exact:true}).click();expect(state.calls).toHaveLength(1);
});

test("offline and background lifecycle clears private goals and unfinished drafts without replay",async({page,context})=>{
  const state=await mockGoals(page,{initial:"empty"});await signInGoals(page);await fillGoal(page);
  await page.getByRole("textbox",{name:"Goal name",exact:true}).fill("Private draft");
  await context.setOffline(true);await expect(page.getByText("You're offline.",{exact:false})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);await expect(page.locator(".goal-list")).toHaveCount(0);
  await context.setOffline(false);await expect(page.getByRole("heading",{name:"Your savings goals",exact:true})).toBeVisible();
  await expect(page.getByRole("textbox")).toHaveCount(0);expect(state.calls).toHaveLength(0);
  await expect(page.getByText("Private draft",{exact:true})).toHaveCount(0);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toMatch(/Emergency fund|Private draft/);
});

test("late selected-goal response cannot replace a newer selection",async({page})=>{
  await mockGoals(page,{initial:"empty",second:true});await signInGoals(page);
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v1/goals/00000000-0000-0000-0000-000000000311",async route=>{await gate;await route.fallback();});
  await page.getByRole("button",{name:"Review Emergency fund"}).click();
  await page.getByRole("button",{name:"Review Travel fund"}).click();
  await expect(page.locator(".goal-detail h2")).toHaveText("Travel fund");release();
  await page.waitForResponse(response=>response.url().endsWith("000000000311/allocations?limit=50"));
  await expect(page.locator(".goal-detail h2")).toHaveText("Travel fund");
});

test("blank target remains invalid and API failures have a reload action",async({page})=>{
  const state=await mockGoals(page);await signInGoals(page);await fillGoal(page);
  await page.getByRole("textbox",{name:"Target (EUR)",exact:true}).fill("0");await page.getByRole("button",{name:"Create goal",exact:true}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("greater than zero");expect(state.calls).toHaveLength(0);
});

test("unavailable goal list offers recovery without inventing an empty owned history",async({page})=>{
  await mockGoals(page,{unavailable:true});await page.goto("/goals");await page.getByRole("button",{name:"Continue as Aino"}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Goal information is unavailable");
  await expect(page.getByText("No savings goal yet.",{exact:false})).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Reload goals",exact:true})).toBeEnabled();
});

test("goal layouts keep long names and reservation actions usable across themes and enlarged text",async({page})=>{
  const state=await mockGoals(page,{initial:"reserved"});state.goals[0].name="Emergency fund for unexpected essential household repairs";
  await signInGoals(page);await page.getByRole("button",{name:`Review ${state.goals[0].name}`}).click();
  await page.getByText("Deadline pacing and calculation details",{exact:true}).click();
  if(process.env.MONEYLENS_CAPTURE_GOALS==="true") await mkdir(".impeccable/review",{recursive:true});
  for(const [width,theme,name] of [[1440,"light","goals-desktop"],[390,"dark","goals-mobile"],[320,"light","goals-enlarged"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    if(name==="goals-enlarged") await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.MONEYLENS_CAPTURE_GOALS==="true") await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
  }
  if(process.env.MONEYLENS_CAPTURE_GOALS==="true") {
    await page.setViewportSize({width:390,height:1000});await page.emulateMedia({colorScheme:"light"});
    await page.evaluate(()=>{document.documentElement.style.fontSize="";});
    await page.getByRole("button",{name:"Edit goal",exact:true}).click();await expect(page.getByRole("heading",{name:"Edit your goal",exact:true})).toBeFocused();
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:".impeccable/review/goals-form.png",fullPage:true,animations:"disabled"});
  }
});
