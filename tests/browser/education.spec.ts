import {expect,test,type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import notes from "../../fixtures/public/education.v1.json";
import {mockAnalysis,signInAnalysis} from "./analysis-support";

type Locale=keyof typeof notes.locales;
type Topic=keyof typeof notes.locales.en;
const help=(page:Page)=>page.locator(".education-help");

async function setup(page:Page,delayFirst=false) {
  await mockAnalysis(page);
  let release:()=>void=()=>{},count=0,failNext=false;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route("**/api/v1/public/education?**",async route=>{
    const url=new URL(route.request().url());
    const locale=url.searchParams.get("locale") as Locale,topic=url.searchParams.get("topic") as Topic;
    count++;
    if(delayFirst && count===1) await gate;
    if(failNext) {failNext=false;return route.fulfill({status:503,json:{error:{code:"EDUCATION_UNAVAILABLE"}}});}
    const titles=notes.locales[locale];
    return route.fulfill({json:{...titles[topic],content_version:"education.v1",audience:"general_education",locale,topic,
      topics:Object.entries(titles).map(([id,value])=>({id,title:value.title}))}});
  });
  await signInAnalysis(page);
  return {release,calls:()=>count,fail:()=>{failNext=true;}};
}

test("learning is optional and localized with expandable practical choices",async({page})=>{
  const state=await setup(page);
  expect(state.calls()).toBe(0);
  await help(page).getByText("Understand the money concepts",{exact:true}).click();
  await expect(help(page).getByRole("heading",{name:notes.locales.en.observed_spending.title})).toBeVisible();
  await page.getByLabel("Money topic",{exact:true}).selectOption("opportunity_cost");
  await page.getByLabel("Explanation language",{exact:true}).selectOption("fi");
  await expect(help(page).locator("article")).toHaveAttribute("lang","fi");
  await expect(help(page)).toContainText(notes.locales.fi.opportunity_cost.summary);
  await help(page).getByText("Hieman tarkemmin",{exact:true}).click();
  await expect(help(page)).toContainText(notes.locales.fi.opportunity_cost.practical_choice);
  await help(page).getByText("Understand the money concepts",{exact:true}).click();
  await expect(help(page).locator("article")).toHaveCount(0);
  await expect(page.locator(".analysis-results")).toHaveCount(0);
});

test("late language responses cannot replace the selected explanation and errors need manual retry",async({page})=>{
  const state=await setup(page,true);
  await help(page).locator(":scope > summary").click();
  await expect.poll(state.calls).toBe(1);
  await page.getByLabel("Explanation language",{exact:true}).selectOption("sv");
  await expect(help(page).locator("article")).toHaveAttribute("lang","sv");
  const late=page.waitForResponse(response=>response.url().includes("locale=en"));
  state.release();await late;
  await expect(help(page).locator("article")).toHaveAttribute("lang","sv");
  state.fail();await page.getByLabel("Money topic",{exact:true}).selectOption("cash_flow");
  await expect(help(page).getByRole("alert")).toBeVisible();
  await expect(help(page).locator("article")).toHaveCount(0);
  const count=state.calls();await page.clock.fastForward(30000);expect(state.calls()).toBe(count);
  await help(page).getByRole("button",{name:"Try learning notes again"}).click();
  await expect(help(page)).toContainText(notes.locales.sv.cash_flow.summary);
});

test("private lifecycle clears the open learning view without replay on reconnect",async({page,context})=>{
  const state=await setup(page);
  await help(page).locator(":scope > summary").click();
  await expect(help(page).locator("article")).toBeVisible();
  await context.setOffline(true);await expect(help(page)).toHaveCount(0);
  await context.setOffline(false);await expect(help(page)).toBeVisible();
  await expect(help(page).locator("article")).toHaveCount(0);expect(state.calls()).toBe(1);
});

test("expanded translated notes fit the inherited desktop mobile dark and enlarged layouts",async({page})=>{
  await setup(page);await help(page).locator(":scope > summary").click();
  await page.getByLabel("Explanation language",{exact:true}).selectOption("sv");
  await page.getByLabel("Money topic",{exact:true}).selectOption("protected_money");
  await expect(help(page)).toContainText(notes.locales.sv.protected_money.summary);
  await help(page).getByText("Lite mer i detalj",{exact:true}).click();
  await mkdir(".impeccable/review",{recursive:true});
  for(const [width,theme,name,enlarged] of [[1440,"light","education-desktop",false],[390,"light","education-mobile",false],
    [390,"dark","education-dark",false],[320,"light","education-enlarged",true]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.evaluate(value=>{document.documentElement.style.fontSize=value ? "200%" : "";},enlarged);
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
