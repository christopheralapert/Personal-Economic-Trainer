import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {choosePopulation,mockPopulation,populationFixture,signInPopulation} from "./population-support";

test("comparison requires explicit choices and displays missing confirmations without private comparison amounts",async({page})=>{
  const state=await mockPopulation(page);await signInPopulation(page);
  await expect(page.getByRole("combobox",{name:"Household group",exact:true})).toHaveValue("");
  await expect(page.getByRole("button",{name:"Compare selected categories"})).toBeDisabled();
  expect(await page.getByRole("checkbox").evaluateAll(inputs=>inputs.every(input=>!(input as HTMLInputElement).checked))).toBe(true);
  await choosePopulation(page,{confirm:false});await page.getByRole("button",{name:"Compare selected categories"}).click();
  await expect(page.getByRole("heading",{name:"Comparison needs review"})).toBeFocused();
  await expect(page.locator(".comparison-results")).toContainText("Confirm whether these accounts cover");
  await expect(page.locator(".comparison-results")).toContainText("seasonal limitations");
  await expect(page.locator(".comparison-amounts")).toHaveCount(0);
  expect(state.calls).toEqual([populationFixture.scenarios.unconfirmed.request]);
});

test("real-engine partial result exposes dated means and original source evidence with no assumed category precision",async({page})=>{
  const state=await mockPopulation(page);await signInPopulation(page);await choosePopulation(page);
  await page.getByRole("button",{name:"Compare selected categories"}).click();
  await expect(page.getByRole("heading",{name:"Some categories need review"})).toBeFocused();
  expect(state.calls).toEqual([populationFixture.scenarios.partial.request]);
  const taxi=page.getByRole("article",{name:/Passenger transport by taxi/});
  await expect(taxi).toContainText("100,00");await expect(taxi).toContainText("Approximate context");
  const food=page.getByRole("article",{name:/Food and non-alcoholic beverages/});
  await expect(food).toContainText("Comparison withheld");await expect(food).toContainText("cannot be assigned precisely");
  await expect(food.locator(".comparison-amounts")).toHaveCount(0);
  await page.getByText("Source, coverage and calculation details",{exact:true}).click();
  await expect(page.locator(".comparison-results")).toContainText(populationFixture.cohorts.catalog.snapshot.response_sha256);
  await expect(page.locator(".comparison-results")).toContainText("Confirmed by you; not bank-verified");
  await expect(page.getByRole("link",{name:"Statistics Finland · table 14ph"})).toHaveAttribute("href",populationFixture.cohorts.catalog.snapshot.source_url);
  await page.getByLabel("Last month (included)",{exact:true}).fill("2026-09");
  await expect(page.locator(".comparison-results")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Compare selected categories"})).toBeDisabled();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("consecutive months");
});

test("overlapping parent and child categories cannot be selected together",async({page})=>{
  await mockPopulation(page);await signInPopulation(page);
  const parent=page.getByRole("checkbox",{name:/11\.1 Food and beverage serving services/});
  const child=page.getByRole("checkbox",{name:/Restaurants, cafés and the like/});
  await parent.check();await expect(child).toBeDisabled();
  await parent.uncheck();await child.check();await expect(parent).toBeDisabled();
  await child.uncheck();await expect(parent).toBeEnabled();
});

test("late results cannot repopulate a comparison after its inputs change",async({page})=>{
  const state=await mockPopulation(page,{delayed:true});await signInPopulation(page);await choosePopulation(page);
  await page.getByRole("button",{name:"Compare selected categories"}).click();
  await expect.poll(()=>state.calls.length).toBe(1);
  const response=page.waitForResponse(response=>response.url().endsWith("/benchmarks/comparison"));
  await page.getByRole("combobox",{name:"Household group",exact:true}).selectOption("2");state.release();await response;
  await expect(page.locator(".comparison-results")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"Compare selected categories"})).toBeEnabled();
});

test("offline and cross-tab invalidation erase private results and confirmations without replay",async({page,context})=>{
  const state=await mockPopulation(page);await signInPopulation(page);await choosePopulation(page);
  await page.getByRole("button",{name:"Compare selected categories"}).click();await expect(page.locator(".comparison-results")).toBeVisible();
  await context.setOffline(true);await expect(page.getByText("You're offline.",{exact:false})).toBeVisible();
  await expect(page.locator(".comparison-results")).toHaveCount(0);await expect(page.getByRole("checkbox")).toHaveCount(0);
  await context.setOffline(false);await expect(page.getByRole("combobox",{name:"Household group",exact:true})).toHaveValue("");
  await expect(page.getByLabel(/I confirm these accounts cover/)).not.toBeChecked();expect(state.calls).toHaveLength(1);
  await choosePopulation(page);await page.getByRole("button",{name:"Compare selected categories"}).click();await expect(page.locator(".comparison-results")).toBeVisible();
  await page.evaluate(()=>{const channel=new BroadcastChannel("moneylens-private-lifecycle-v1");channel.postMessage({type:"invalidate"});channel.close();});
  await expect(page.locator(".comparison-results")).toHaveCount(0);await expect(page.getByRole("combobox",{name:"Household group",exact:true})).toHaveValue("");
  expect(state.calls).toHaveLength(2);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain("10000");
});

for(const kind of ["unavailableMetadata","failComparison","unavailable","stale","suppressed","annual_short"] as const) test(`comparison handles ${kind} without invented comparison amounts`,async({page})=>{
  const state=await mockPopulation(page,kind==="unavailableMetadata" ? {unavailableMetadata:true} : kind==="failComparison" ? {failComparison:true} : {scenario:kind});
  await signInPopulation(page);
  if(kind==="unavailableMetadata") {
    await expect(page.getByRole("main").getByRole("alert")).toContainText("Verified population source details are unavailable");await expect(page.getByRole("button",{name:"Compare selected categories"})).toHaveCount(0);expect(state.calls).toHaveLength(0);return;
  }
  const scenario=populationFixture.scenarios[kind==="failComparison" ? "partial" : kind];
  await choosePopulation(page,{categories:scenario.request.coicop_codes,household:scenario.request.household_code});
  if(kind==="annual_short") await page.getByRole("combobox",{name:"Comparison basis",exact:true}).selectOption("annual_observed");
  await page.getByRole("button",{name:"Compare selected categories"}).click();
  if(kind==="failComparison") {await expect(page.getByRole("main").getByRole("alert")).toContainText("A bank source needs attention");await expect(page.locator(".comparison-results")).toHaveCount(0);}
  else {
    await expect(page.locator(".comparison-results")).toBeVisible();await expect(page.locator(".comparison-amounts")).toHaveCount(0);
    if(kind==="suppressed") await expect(page.locator(".comparison-results")).toContainText("unavailable or suppressed");
    if(kind==="stale") await expect(page.locator(".comparison-results")).toContainText("fresh published observation");
    if(kind==="annual_short") await expect(page.locator(".comparison-results")).toContainText("twelve complete calendar months");
  }
});

test("population form and evidence fit desktop mobile dark and enlarged text layouts",async({page})=>{
  await mockPopulation(page);await signInPopulation(page);await choosePopulation(page);
  await page.getByRole("button",{name:"Compare selected categories"}).click();await expect(page.locator(".comparison-results")).toBeVisible();
  await mkdir(".impeccable/review",{recursive:true});
  for(const [width,theme,name,evidence] of [[1440,"light","population-desktop",false],[320,"dark","population-mobile",false],[1440,"light","population-evidence",true],[320,"light","population-enlarged",false]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme,reducedMotion:"reduce"});
    await page.locator(".comparison-results details").evaluate((element,open)=>{(element as HTMLDetailsElement).open=open;},evidence);
    if(name==="population-enlarged") await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    const active=page.getByRole("heading",{name:"Your spending, in context.",exact:true});
    await expect(active).toBeVisible();
    expect(await active.evaluate(element=>{const bounds=element.getBoundingClientRect();return bounds.left>=0 && bounds.right<=innerWidth && element.scrollWidth<=element.clientWidth;})).toBe(true);
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});
