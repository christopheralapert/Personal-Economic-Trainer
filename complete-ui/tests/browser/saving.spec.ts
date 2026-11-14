import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");

test("localized saving education prepares a review with the configured target and opens the existing local goal flow",async({page})=>{
  let calls=0;page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) calls++;});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
  for(const copy of [en,fi,et]) {
    await page.goto("/");await page.evaluate(()=>localStorage.removeItem("money-coach-preferences.v1"));await page.reload();await page.getByRole("button",{name:en.settings,exact:true}).click();await page.getByLabel(copy===fi ? en.finnish : copy===et ? en.estonian : en.english,{exact:true}).check();
    await page.getByRole("slider",{name:copy.target,exact:true}).press("End");await page.getByRole("button",{name:copy.overview,exact:true}).click();
    await page.getByRole("tab",{name:copy.learn,exact:true}).click();const before=calls;
    await page.getByRole("button",{name:new RegExp(copy.savingConcept)}).click();
    const answer=page.locator("article").last();await expect(answer).toContainText(copy.saveRoom);expect(calls).toBe(before+1);
    await answer.getByRole("button",{name:copy.calculation,exact:true}).click();await expect(page.getByRole("dialog")).toContainText(copy.safeSaveNote);await expect(page.getByRole("dialog")).toContainText(/100\s%/);await page.getByRole("dialog").getByRole("button",{name:copy.done,exact:true}).click();
    await answer.getByRole("button",{name:copy.goal,exact:true}).click();await expect(page.getByRole("textbox",{name:copy.goalName,exact:true})).toBeFocused();
    await page.getByRole("button",{name:copy.back,exact:true}).first().click();await expect(answer).toContainText(copy.saveRoom);
  }
});

test("saving and spending remain distinct offline while the illustration stays inside its explanation",async({page,context})=>{
  let calls=0;page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) calls++;});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?question="+encodeURIComponent(en.qSafe));await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText(en.week);await context.setOffline(true);
  await page.locator("article").last().getByRole("button",{name:en.qSave,exact:true}).click();const answer=page.locator("article").last();
  await expect(answer).toContainText(en.saveRoom);await expect(answer).not.toContainText(en.week);await answer.getByRole("button",{name:en.calculation,exact:true}).click();await expect(page.getByRole("dialog")).toContainText(en.noIncome);await expect(page.getByRole("dialog")).not.toContainText(en.stale);

  await expect(page.getByRole("dialog")).toContainText(en.afterReserves);await expect(page.getByRole("dialog")).toContainText("200,00");await expect(page.getByRole("dialog")).toContainText(en.notSavingAllowance);await page.getByRole("dialog").getByRole("button",{name:en.done,exact:true}).click();
  for(const colorScheme of ["light","dark"] as const) {await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/safe-saving-${colorScheme}.png`,fullPage:true});}
  await page.locator("article").last().getByRole("button",{name:en.qSafe,exact:true}).click();await expect(page.locator("article").last()).toContainText(en.week);expect(calls).toBe(1);
  await context.setOffline(false);
});

test("received-income test evidence reconciles the target once and contradictory headroom is withheld",async({page})=>{
  // Explicit test-only review evidence; the public source has no income records.
  let contradictory=false;
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch(),body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available") {const value=part.output.result;value.realizedIncome=10000;value.savings=1000;value.illustrativeHeadroom=contradictory ? 20000 : 19000;value.reasons=value.reasons.filter((reason:string)=>reason!=="income_missing");}
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await page.goto("/?question="+encodeURIComponent(en.qSave));await page.getByRole("button",{name:en.send,exact:true}).click();let answer=page.locator("article").last();
  await expect(answer).not.toContainText(en.noIncome);await answer.getByRole("button",{name:en.calculation,exact:true}).click();
  await expect(page.getByRole("dialog").getByText(en.afterReserves,{exact:false})).toContainText("190,00");await expect(page.getByRole("dialog")).not.toContainText("200,00");await page.getByRole("dialog").getByRole("button",{name:en.done,exact:true}).click();
  contradictory=true;await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill(en.qSave);await page.getByRole("button",{name:en.send,exact:true}).click();answer=page.locator("article").last();
  await expect(answer).toContainText(en.unknown);await expect(answer).not.toContainText("200,00");
});
