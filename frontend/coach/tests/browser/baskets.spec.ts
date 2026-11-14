import {openOverview} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("localized overview basket actions carry the selected period and merchant actions preserve the basket",async({page})=>{
  const requests:Record<string,unknown>[]=[];page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
  for(const copy of [en,fi,et]) {
    await page.goto("/");await page.evaluate(()=>localStorage.removeItem("money-coach-preferences.v1"));await page.reload();await page.getByRole("button",{name:en.settings,exact:true}).click();await page.getByLabel(copy===fi ? en.finnish : copy===et ? en.estonian : en.english,{exact:true}).check();await page.getByRole("button",{name:copy.overview,exact:true}).click();
    await openOverview(page,copy);await page.getByRole("button",{name:copy.previousPeriod,exact:true}).click();await page.locator('[data-overview-block="baskets"]').getByRole("button").filter({hasText:copy.everydayShort}).click();await page.locator('#learn-everyday').getByRole("button").click();
    let answer=page.locator("article").last();await expect(answer).toContainText("250,00");await checkBasis(page,answer,copy,"30.9.2026");await expect(answer).toContainText(copy.dining);
    const merchant=answer.locator("li button").first();await merchant.click();answer=page.locator("article").last();await expect(answer).toContainText("250,00");await expect(answer).toContainText(copy.dining);
    expect(JSON.stringify(requests.at(-1))).toContain('everyday');expect(JSON.stringify(requests.at(-1))).toContain('2026-09-01');
  }
  expect(requests).toHaveLength(6);
});

test("inline basket continuation keeps intersected selectors until explicit clearing",async({page,context})=>{
  await page.goto("/?question="+encodeURIComponent(en.qBaskets));await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText("350,00");
  await page.locator("article").last().getByRole("button",{name:en.qFollowBasket,exact:true}).click();
  let answer=page.locator("article").last();await expect(answer).toContainText("306,50");await expect(answer).toContainText(en.dining);await expect(answer).not.toContainText("S-market");
  const input=page.getByRole("textbox",{name:en.questionLabel,exact:true});
  await input.fill('Show all transactions in basket "mandatory_irregular" last month');await page.getByRole("button",{name:en.send,exact:true}).click();
  answer=page.locator("article").last();await expect(answer).toContainText("S-market");await expect(answer).toContainText(en.irregular);await expect(answer).not.toContainText("City taxi");
  await context.setOffline(true);await input.fill('And at "S-market"?');await page.getByRole("button",{name:en.send,exact:true}).click();
  answer=page.locator("article").last();await expect(answer.locator("li")).toHaveCount(1);await expect(answer).toContainText(en.irregular);
  await answer.getByRole("button",{name:en.clearScope,exact:true}).click();await expect(answer).toContainText(en.scopeAll);await expect(answer).toContainText("City taxi");
  await context.setOffline(false);
});

test("profile evidence and unclassified baskets open exact records without inventing a spender score",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/?question="+encodeURIComponent(en.qProfile));await page.getByRole("button",{name:en.send,exact:true}).click();
  let answer=page.locator("article").last();await expect(answer).toContainText(en.profileType.replace("{category}",en.housing));await expect(answer).toContainText("before refunds");await expect(answer.locator("dl > div")).toHaveCount(3);
  for(const colorScheme of ["light","dark"] as const) {await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/profile-evidence-${colorScheme}.png`});}
  await answer.getByRole("button",{name:en.exploreCategory.replace("{category}",en.housing),exact:true}).click();await expect(page.locator("article").last()).toContainText("350,00");
  await page.getByRole("tab",{name:en.overview,exact:true}).click();await page.getByRole("button",{name:"Switch to November so far",exact:true}).click();await page.getByRole("tab",{name:en.coach,exact:true}).click();
  await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill("Show my three baskets this month");await page.getByRole("button",{name:en.send,exact:true}).click();
  answer=page.locator("article").last();await expect(answer).toContainText(en.unresolved);await expect(answer.getByRole("button",{name:en.exploreBasket.replace("{basket}",en.regular),exact:true})).toHaveCount(0);
  await answer.getByRole("button",{name:en.exploreBasket.replace("{basket}",en.unresolved),exact:true}).click();answer=page.locator("article").last();await expect(answer).toContainText("12,50");await expect(answer.locator("li")).toHaveCount(1);
});
