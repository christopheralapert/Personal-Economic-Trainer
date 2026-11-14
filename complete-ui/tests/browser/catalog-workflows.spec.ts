import {checkBasis} from "../basis";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");

test("chat status and period tools apply real local filters and the goal tool opens editable setup",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("tab",{name:en.coach,exact:true}).click();
  const input=page.getByRole("textbox",{name:en.questionLabel,exact:true}),send=page.getByRole("button",{name:en.send,exact:true});
  await input.fill("Show reserved transactions last month");await send.click();
  const answer=page.locator("article").last();await expect(answer).toContainText(en.emptyRecords);
  await checkBasis(page,answer,en,"31.10.2026");
  await answer.getByRole("button",{name:en.filter,exact:true}).click();
  await page.getByRole("radio",{name:en.booked,exact:true}).check();
  await page.getByRole("button",{name:en.done,exact:true}).click();
  await expect(answer).toContainText("Taxi Helsinki");await expect(answer).toContainText("City taxi");
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/chat-history-${colorScheme}.png`,fullPage:true});}
  await input.fill("Change period");await send.click();await expect(answer.getByRole("button",{name:en.choosePeriod,exact:true})).toBeVisible();
  await answer.getByRole("button",{name:en.choosePeriod,exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:en.snapshotPeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.apply,exact:true}).click();
  await expect(answer).toContainText("12,50");await expect(answer).not.toContainText("250,00");await checkBasis(page,answer,en,"4.11.2026");
  await input.fill("Set a savings goal");await send.click();await answer.getByRole("button",{name:en.openGoal,exact:true}).click();
  await expect(page.getByLabel(en.goalName,{exact:true})).toBeFocused();await page.getByLabel(en.goalName,{exact:true}).fill("Travel");
  await page.getByLabel(en.goalName,{exact:true}).press("Enter");await expect(page.getByLabel(en.goalAmount,{exact:true})).toBeFocused();
  await page.goto("/kit");await page.locator('[data-component="showStepper"]').getByRole("button",{name:en.openGoal,exact:true}).click();
  await expect(page.getByLabel(en.goalName,{exact:true})).toBeVisible();await expect(page).not.toHaveURL(/goal=1/);
});

test("source inventory is translated, dated and readable without assuming continuous coverage",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("button",{name:en.settings,exact:true}).click();
  for(const copy of [en,fi,et]) {
    await page.getByLabel(copy===en ? en.english : copy===fi ? en.finnish : en.estonian,{exact:true}).check();
    const inventory=page.locator("section").filter({has:page.getByRole("heading",{name:copy.source,exact:true})});
    await expect(inventory).toContainText(copy.inventoryNote);await expect(inventory).toContainText("4.11.2026");
    await expect(inventory.locator("dl div").filter({has:page.getByText(copy.transactions,{exact:true})}).locator("dd")).toHaveText("13");
    for(const width of [360,390,430,768]) {await page.setViewportSize({width,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});await page.setViewportSize({width:390,height:844});
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/source-inventory-${colorScheme}.png`,fullPage:true});}
});

test("long unsupported questions wrap and a failed component recovers without automatic resubmission",async({page})=>{
  await page.setViewportSize({width:360,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("tab",{name:en.coach,exact:true}).click();const input=page.getByRole("textbox",{name:en.questionLabel,exact:true}),send=page.getByRole("button",{name:en.send,exact:true});
  await input.fill("x".repeat(2000));await send.click();await expect(page.locator("article").last()).toContainText(en.unknown);
  await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  let calls=0;page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) calls++;});
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch();const body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available"){part.output.category="unavailable-category";}
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await input.fill(en.qWhatif);await send.click();await expect(page.getByRole("heading",{name:en.pageFailed,exact:true})).toBeVisible();
  await expect(page.locator("main")).not.toContainText("unavailable-category");
  await page.getByRole("button",{name:en.retry,exact:true}).click();await expect(page.getByRole("tab",{name:en.overview,exact:true})).toBeVisible();expect(calls).toBe(1);
  await page.goto("/missing-demo-page");await expect(page.getByRole("heading",{name:en.pageMissing,exact:true})).toBeVisible();
  await page.getByRole("link",{name:en.overview,exact:true}).click();await expect(page.getByRole("tab",{name:en.overview,exact:true})).toBeVisible();
});
