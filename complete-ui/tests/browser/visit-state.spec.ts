import {checkBasis} from "../basis";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("independent interactive answers retain exact choices across tabs and language settings, then clear explicitly",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();
  const input=page.getByRole("textbox",{name:en.questionLabel,exact:true}),send=page.getByRole("button",{name:en.send,exact:true});
  await input.fill(en.qWhatif);await send.click();const first=page.locator("article").nth(1);await first.getByRole("slider").focus();await page.keyboard.press("End");await expect(first).toContainText("250,00");
  await input.fill(en.qWhatif);await send.click();await expect(page.locator("article").nth(3).getByRole("slider")).toHaveAttribute("aria-valuenow","20");
  await input.fill(en.qDonut);await send.click();const donut=page.locator("article").last();await donut.getByRole("button",{name:en.choosePeriod,exact:true}).click();
  await page.getByRole("dialog").getByRole("button",{name:en.previousPeriod,exact:true}).last().click();await page.getByRole("dialog").getByRole("button",{name:en.apply,exact:true}).click();await donut.getByRole("button",{name:/350,00/}).click();await page.getByRole("dialog",{name:en.housing,exact:true}).getByRole("button",{name:en.done,exact:true}).click();
  await page.getByRole("tab",{name:en.learn,exact:true}).click();await page.getByRole("tab",{name:en.coach,exact:true}).click();
  await expect(first.getByRole("slider")).toHaveAttribute("aria-valuenow","100");await expect(first).toContainText("250,00");
  await expect(donut.getByRole("button",{name:/350,00/})).toHaveAttribute("aria-pressed","true");await checkBasis(page,donut,en,"31.10.2026");
  await page.getByRole("button",{name:en.settings,exact:true}).click();await page.getByLabel(en.estonian,{exact:true}).check();await page.getByRole("button",{name:et.back,exact:true}).click();
  await expect(page.locator("article")).toHaveCount(0);
  await page.getByRole("button",{name:et.settings,exact:true}).click();await page.getByLabel(et.english,{exact:true}).check();await page.getByRole("button",{name:en.back,exact:true}).click();
  await expect(first.getByRole("slider")).toHaveAttribute("aria-valuenow","100");await expect(donut.getByRole("button",{name:/350,00/})).toHaveAttribute("aria-pressed","true");
  await page.getByRole("button",{name:en.clear,exact:true}).click();await expect(page.locator("article")).toHaveCount(0);
  await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill(en.qWhatif);await page.getByRole("button",{name:en.send,exact:true}).click();await expect(page.locator("article").last().getByRole("slider")).toHaveAttribute("aria-valuenow","20");
});

test("history paging and confirmed status survive leaving the coach without committing dismissed drafts",async({page})=>{
  // Use a smaller valid page of the real source to exercise restoration; no transactions are invented.
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch();const body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available") part.output={...part.output,pageSize:5,rows:part.output.rows.slice(0,5)};
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill("Show all transactions last month");await page.getByRole("button",{name:en.send,exact:true}).click();
  const answer=page.locator("article").last();await answer.getByRole("button",{name:en.nextPage,exact:true}).click();await expect(answer).toContainText("Page 2 of 2");
  await page.getByRole("tab",{name:en.overview,exact:true}).click();await page.getByRole("tab",{name:en.coach,exact:true}).click();await expect(answer).toContainText("Page 2 of 2");
  await answer.getByRole("button",{name:en.filter,exact:true}).click();await page.getByRole("radio",{name:en.reserved,exact:true}).check();await page.getByRole("button",{name:en.done,exact:true}).click();await expect(answer).toContainText(en.emptyRecords);
  await page.getByRole("tab",{name:en.learn,exact:true}).click();await page.getByRole("tab",{name:en.coach,exact:true}).click();await expect(answer).toContainText(en.emptyRecords);
  await answer.getByRole("button",{name:en.filter,exact:true}).click();await expect(page.getByRole("radio",{name:en.reserved,exact:true})).toBeChecked();await page.keyboard.press("Escape");
});

test("monthly simulator choices survive navigation and goal setup returns to its source without promising affordability",async({page})=>{
  let calls=0;page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) calls++;});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");await page.getByRole("tab",{name:en.whatif,exact:true}).click();
  const combined=page.getByRole("region",{name:en.combined,exact:true}),dining=page.getByRole("slider",{name:`${en.reduce} ${en.dining}`,exact:true});
  await expect(combined).toContainText("61,30");await dining.focus();await page.keyboard.press("Home");await expect(combined).toContainText("11,30");
  async function month(date:string){await page.getByRole("button",{name:date==="1.9.2026" ? en.previousPeriod : en.nextPeriod,exact:true}).click();}
  await month("1.9.2026");await expect(combined).toContainText("50,00");await dining.focus();await page.keyboard.press("End");await expect(combined).toContainText("250,00");
  await month("1.10.2026");await expect(dining).toHaveAttribute("aria-valuenow","0");await expect(combined).toContainText("11,30");await month("1.9.2026");
  await page.getByRole("tab",{name:en.learn,exact:true}).click();await page.getByRole("tab",{name:en.whatif,exact:true}).click();await expect(dining).toHaveAttribute("aria-valuenow","100");await expect(combined).toContainText("250,00");
  await page.getByRole("tab",{name:en.coach,exact:true}).click();await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill("Set a savings goal");await page.getByRole("button",{name:en.send,exact:true}).click();await page.getByRole("button",{name:en.openGoal,exact:true}).click();
  await page.getByLabel(en.goalName,{exact:true}).fill("Trip");await page.getByLabel(en.goalName,{exact:true}).press("Enter");await page.getByLabel(en.goalAmount,{exact:true}).fill("1000");await page.getByLabel(en.goalAmount,{exact:true}).press("Enter");await page.getByRole("button",{name:en.saveGoal,exact:true}).click();
  await expect(page.getByRole("tab",{name:en.coach,exact:true})).toHaveAttribute("aria-selected","true");
  await page.getByRole("button",{name:en.clear,exact:true}).click();await page.getByRole("tab",{name:en.whatif,exact:true}).click();await expect(dining).toHaveAttribute("aria-valuenow","100");await expect(page.getByText(en.goalScenarioMonths.replace("{months}","4"),{exact:true})).toBeVisible();
  await dining.focus();await page.keyboard.press("Home");await expect(page.getByText(en.goalScenarioUnavailable,{exact:true})).toBeVisible();await page.getByRole("button",{name:en.resetScenario,exact:true}).click();await expect(combined).toContainText("50,00");await expect(page.getByText(en.goalScenarioMonths.replace("{months}","20"),{exact:true})).toBeVisible();
  let current=en;
  for(const copy of [fi,et,en]) {
    await page.getByRole("button",{name:current.settings,exact:true}).click();await page.getByLabel(copy===fi ? en.finnish : copy===et ? en.estonian : en.english,{exact:true}).check();await page.getByRole("button",{name:copy.back,exact:true}).click();current=copy;
    await expect(page.getByText(copy.goalScenarioMonths.replace("{months}","20"),{exact:true})).toBeVisible();
    await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});
    for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});await page.setViewportSize({width:390,height:844});
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/monthly-goal-${colorScheme}.png`,fullPage:true});}
  expect(calls).toBe(1);await page.reload();await page.getByRole("tab",{name:en.whatif,exact:true}).click();await expect(combined).toContainText("61,30");await expect(page.getByText("Trip",{exact:false})).toHaveCount(0);
});
