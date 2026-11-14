import {openOverview,openRecords} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect} from "@playwright/test";
import path from "node:path";
import source from "../../data/demo.v1.json";
import {en,et} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");

test("history search intersects status and localized categories without changing expense totals",async({page})=>{
 await page.goto('/');await openRecords(page);const answer=page.locator('article').last(),search=answer.getByRole('searchbox',{name:en.searchTransactions,exact:true});await search.fill('helsinki');await expect(answer).toContainText('Matching transactions: 1');await expect(answer).toContainText('Taxi Helsinki');await expect(answer).not.toContainText('City taxi');await search.fill('groceries');await expect(answer).toContainText('Matching transactions: 2');await search.fill('%');await expect(answer).toContainText(en.emptyRecords);await answer.getByRole('button',{name:en.clearSearch,exact:true}).click();await expect(search).toHaveValue('');await openOverview(page);await expect(page.locator('[data-chart-total]')).toHaveAttribute('data-chart-total','86450');
 await page.getByRole('button',{name:en.settings,exact:true}).click();await page.getByLabel(en.estonian,{exact:true}).check();await page.getByRole('button',{name:et.overview,exact:true}).click();await openRecords(page,et);const localized=page.locator('article').last();await localized.getByRole('searchbox',{name:et.searchTransactions,exact:true}).fill('kohv');await expect(localized).toContainText(et.matchedTransactions.replace('{count}','1'));await expect(localized).toContainText('Coffee purchases');await localized.getByRole('button',{name:et.filter,exact:true}).click();await page.getByLabel(et.reserved,{exact:true}).check();await page.getByRole('button',{name:et.done,exact:true}).click();await expect(localized).toContainText(et.matchedTransactions.replace('{count}','0'));
});

test("invalid pages are withheld and later pages refuse a different local snapshot",async({page})=>{
  let oversized=true;
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch(),body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;
      const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available") part.output=oversized ? {...part.output,rows:Array(26).fill(part.output.rows[0])} : {...part.output,pageSize:1,total:80,financialCount:80,netExpenses:8000,rows:part.output.rows.slice(0,1)};
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await page.goto("/?question="+encodeURIComponent(en.qTaxi));await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText(en.unknown);await expect(page.locator("article").last().locator("li")).toHaveCount(0);
  oversized=false;await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill(en.qTaxi);await page.getByRole("button",{name:en.send,exact:true}).click();
  const answer=page.locator("article").last();await expect(answer).toContainText("80,00");
  await answer.getByRole("button",{name:en.nextPage,exact:true}).click();await expect(answer).toContainText(en.historyPageUnavailable);await expect(answer.locator("li")).toHaveCount(0);
});

test("kit demonstrates real-source page navigation offline without chat traffic",async({page,context})=>{
  let calls=0;page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) calls++;});
  await page.goto("/kit");const example=page.locator('[data-component="showTransactions"]');
  await expect(example).toContainText("Page 1 of 2");await expect(example.locator("li")).toHaveCount(5);
  await context.setOffline(true);await example.getByRole("button",{name:en.nextPage,exact:true}).click();
  await expect(example).toContainText("Page 2 of 2");await expect(example.locator("li")).toHaveCount(5);expect(calls).toBe(0);
  await context.setOffline(false);
});

test("chat simulation framing follows changes and full simulator resets exact monthly and yearly totals",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("tab",{name:"Coach",exact:true}).click();
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill("What if I cut dining out by 20%?");await page.getByRole("button",{name:"Send question",exact:true}).click();
  const answer=page.locator("article").last(),slider=answer.getByRole("slider");
  await expect(answer).toContainText("50,00");await slider.focus();await page.keyboard.press("ArrowRight");
  await expect(answer.locator("p.text-3xl")).toContainText("52,50");
  await expect(answer.locator("p.text-3xl")).not.toContainText("50,00");
  await checkBasis(page,answer,undefined,"1.10.2026 to 31.10.2026");
  await page.getByRole("tab",{name:"What if",exact:true}).click();const combined=page.getByRole("region",{name:"Combined reduction",exact:true});
  await expect(combined).toContainText("61,30");await expect(combined).toContainText("735,60");
  const dining=page.getByRole("slider",{name:"Reduce by Dining out",exact:true});await dining.focus();await page.keyboard.press("ArrowRight");
  await expect(combined).toContainText("63,80");await expect(combined).toContainText("765,60");
  await page.getByRole("button",{name:"Reset to 20%",exact:true}).click();await expect(dining).toHaveAttribute("aria-valuenow","20");await expect(combined).toContainText("61,30");
  await page.getByRole("tab",{name:"Coach",exact:true}).click();await page.getByRole("textbox",{name:"Your question",exact:true}).fill("Compare me to others");await page.getByRole("button",{name:"Send question",exact:true}).click();
  const comparison=page.locator("article").last();await expect(comparison.getByRole("heading",{name:"Taxis",exact:true})).toBeVisible();
  await expect(async()=>{
    const answer=await comparison.getByRole("heading",{name:"Taxis",exact:true}).boundingBox(),composer=await page.locator("form").locator("..").boundingBox();
    expect(answer!.y+answer!.height).toBeLessThanOrEqual(composer!.y);
  }).toPass();
  await checkBasis(page,comparison,undefined,"1.10.2026 to 31.10.2026");
  await expect(comparison.getByRole("progressbar",{name:"Your recorded month",exact:true})).toHaveAttribute("aria-valuetext",/40,00/);
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await comparison.screenshot({path:`${captures}/comparison-${colorScheme}.png`});}
});

test("bounded source pages keep full totals, every row, keyboard focus and drafts",async({page})=>{
  // A smaller valid first page makes the real ten-row source exercise four pages.
  const rows=source.profiles[0].transactions.filter(row=>row.status==="booked" && row.booked_on>="2026-10-01" && row.booked_on<"2026-11-01").sort((a,b)=>b.booked_on.localeCompare(a.booked_on));
  let calls=0;
  page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) calls++;});
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch();
    const body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;
      const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available") part.output={...part.output,pageSize:3,rows:part.output.rows.slice(0,3)};
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});
  await page.goto("/?question="+encodeURIComponent("Show transactions last month"));await page.getByRole("button",{name:"Send question",exact:true}).click();
  const answer=page.locator("article").last(),next=answer.getByRole("button",{name:"Next",exact:true}),seen:string[]=[];
  await expect(answer).toContainText("864,50");await expect(answer).toContainText("Page 1 of 4");
  for(let number=1;number<=4;number++) {
    await expect(answer.getByRole("status")).toContainText(`Page ${number} of 4`);
    await expect(answer.locator("li")).toHaveCount(number===4 ? 1 : 3);
    seen.push(...await answer.locator("li button").allTextContents());
    if(number<4) await next.click();
  }
  expect(seen).toEqual(rows.map(row=>row.merchant));await expect(next).toBeDisabled();expect(calls).toBe(1);
  await answer.getByRole("button",{name:"Previous",exact:true}).click();await expect(answer.getByRole("status")).toContainText("Page 3 of 4");
  await expect(answer.getByRole("heading").nth(1)).toBeFocused();
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill("Unsent draft");await expect(answer.getByRole("status")).toContainText("Page 3 of 4");
  for(const colorScheme of ["light","dark"] as const) {await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/paged-history-${colorScheme}.png`});}
});
