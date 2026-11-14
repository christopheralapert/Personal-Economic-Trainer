import {openOverview} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("category and merchant actions keep the selected source period through the actual localized chat route",async({page})=>{
  const questions:string[]=[];page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) questions.push(request.postDataJSON().messages[0].parts[0].text);});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
  for(const copy of [en,fi,et]) {
    await page.goto("/");await page.evaluate(()=>localStorage.removeItem("money-coach-preferences.v1"));await page.reload();await page.getByRole("button",{name:en.settings,exact:true}).click();await page.getByLabel(copy===en ? en.english : copy===fi ? en.finnish : en.estonian,{exact:true}).check();await page.getByRole("tab",{name:copy.overview,exact:true}).click();
    await openOverview(page,copy);await page.getByRole("button",{name:copy.switchCurrent.replace("{month}",copy===fi ? "marraskuu" : copy===et ? "november" : "November"),exact:true}).click();
    await page.getByRole("button",{name:new RegExp(copy.taxi)}).first().click();await page.getByRole("dialog").getByRole("button",{name:copy.exploreCategory.replace("{category}",copy.taxi),exact:true}).click();
    let answer=page.locator("article").last();await expect(answer).toContainText("12,50");await expect(answer).not.toContainText("18,90");expect(questions.at(-1)).toContain('"taxi"');expect(questions.at(-1)).toContain("2026-11-01");expect(questions.at(-1)).toContain("2026-11-04");
    await answer.getByRole("button",{name:"Taxi Helsinki",exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:copy.exploreMerchant.replace("{merchant}","Taxi Helsinki"),exact:true}).click();
    answer=page.locator("article").last();await expect(answer).toContainText("12,50");await expect(answer).not.toContainText("18,90");expect(questions.at(-1)).toContain('"Taxi Helsinki"');expect(questions.at(-1)).toContain("2026-11-04");
  }
  expect(questions).toHaveLength(6);
});

test("inline history intersects literal selectors while period, status and clear actions stay local and retain their scope",async({page})=>{
  let calls=0;page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) calls++;});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill('Show booked transactions in category "taxi" at "Helsinki" last month');await page.getByRole("button",{name:en.send,exact:true}).click();
  const answer=page.locator("article").last();await expect(answer).toContainText("18,90");await expect(answer).not.toContainText("City taxi");await expect(answer.locator("dl div").filter({has:page.getByText("Merchant:",{exact:true})})).toContainText("Helsinki");
  await answer.getByRole("button",{name:en.choosePeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.snapshotPeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.apply,exact:true}).click();await expect(answer).toContainText("12,50");await expect(answer).not.toContainText("18,90");await checkBasis(page,answer,en,"4.11.2026");
  async function status(name:string){await answer.getByRole("button",{name:en.filter,exact:true}).click();await page.getByRole("radio",{name,exact:true}).check();await page.getByRole("button",{name:en.done,exact:true}).click();}
  await status(en.reversed);await expect(answer).toContainText(en.emptyRecords);await expect(answer.locator("dl div").filter({has:page.getByText("Merchant:",{exact:true})})).toContainText("Helsinki");await status(en.all);await expect(answer).toContainText("12,50");
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/scoped-history-${colorScheme}.png`,fullPage:true});}
  await answer.getByRole("button",{name:en.clearScope,exact:true}).click();await expect(answer).toContainText(en.scopeAll);await expect(answer.getByRole("button",{name:en.clearScope,exact:true})).toHaveCount(0);
  await answer.getByRole("button",{name:en.choosePeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.previousPeriod,exact:true}).last().click();await page.getByRole("dialog").getByRole("button",{name:en.apply,exact:true}).click();await expect(answer).toContainText("S-market");await expect(answer).toContainText("City taxi");
  await page.getByRole("tab",{name:en.learn,exact:true}).click();await page.getByRole("tab",{name:en.coach,exact:true}).click();await expect(answer).toContainText("S-market");await expect(answer).toContainText(en.scopeAll);expect(calls).toBe(1);
  const followRequest=page.waitForRequest(r=>r.method()==="POST" && r.url().endsWith("/api/chat"));
  await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill('And at "City taxi"?');
  await page.getByRole("button",{name:en.send,exact:true}).click();
  expect((await followRequest).postDataJSON().context).toEqual({tool:"showFilter",input:{period:{start:"2026-10-01",end:"2026-11-01"},value:"all"}});
  await expect(page.locator("article").last()).toContainText("21,10");
  await expect(page.locator("article").last()).not.toContainText("S-market");
});

test("a selected chart category drills into its refined period rather than the default month",async({page})=>{
  await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill(en.qDonut);await page.getByRole("button",{name:en.send,exact:true}).click();
  const chart=page.locator("article").last();await chart.getByRole("button",{name:en.choosePeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.snapshotPeriod,exact:true}).click();await page.getByRole("dialog").getByRole("button",{name:en.apply,exact:true}).click();
  await chart.getByRole("button",{name:/12,50/}).click();const sheet=page.getByRole("dialog",{name:en.taxi,exact:true});await expect(sheet).toContainText("12,50");await expect(sheet).not.toContainText("40,00");await expect(sheet).toContainText("1.11.2026");await sheet.getByRole("button",{name:en.done,exact:true}).click();
});
