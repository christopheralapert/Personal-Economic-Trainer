import {expectExtendedSource} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {spendByCategory,simulateReduction,lastMonth} from "../../src/engine";
import {extendedDemo} from "../../src/engine/datasets";
import {money} from "../../src/lib/format";
const output=path.resolve(__dirname,"../../../../.impeccable/review/month-choice");
test("offline month clarification preserves the question and explicit month overrides selection",async({page,context})=>{
 for(const colorScheme of ["light","dark"] as const){
  await context.setOffline(false);await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme,reducedMotion:"reduce"});await page.goto("/?dataset=extended");
  await expectExtendedSource(page);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener("controllerchange",()=>resolve(),{once:true}));});await context.setOffline(true);
  await page.getByRole("button",{name:"Switch to November so far",exact:true}).click();await page.getByRole("tab",{name:"Coach",exact:true}).click();
  if(colorScheme==="dark")await page.getByRole("button",{name:"Clear conversation",exact:true}).click();
  const ask=async(question:string)=>{await page.getByRole("textbox",{name:"Your question",exact:true}).fill(question);await page.getByRole("button",{name:"Send question",exact:true}).click();};
  await ask("What if I cut dining out by 20%?");await expect(page.getByRole("button",{name:"Choose a month",exact:true})).toBeVisible();await page.screenshot({path:`${output}/clarification-${colorScheme}.png`});
  await page.getByRole("button",{name:"Choose a month",exact:true}).click();const sheet=page.getByRole("dialog",{name:"Choose a month",exact:true});await expect(sheet.getByRole("radio",{name:/November/})).toHaveCount(0);
  for(const width of [360,390,430]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:`${output}/sheet-${colorScheme}.png`});await sheet.getByRole("radio",{name:"October 2026",exact:true}).check();await sheet.getByRole("button",{name:"Show period",exact:true}).click();
  await expect(page.locator("article").last()).toContainText(money(simulateReduction("dining",20,lastMonth,extendedDemo).monthly));
  await ask("How much did I spend on taxis in April 2026?");await page.getByRole("button",{name:"Choose a month",exact:true}).click();await expect(sheet.getByRole("radio",{name:/April/})).toHaveCount(0);await sheet.getByRole("radio",{name:"September 2026",exact:true}).check();await sheet.getByRole("button",{name:"Show period",exact:true}).click();
  await expect(page.locator("article").last()).toContainText(money(spendByCategory({start:"2026-09-01",end:"2026-10-01"},extendedDemo).find(group=>group.key==="taxi")!.amount));
  await ask("In June 2026, how much did I spend on taxis?");await expect(page.locator("article").last()).toContainText(money(spendByCategory({start:"2026-06-01",end:"2026-07-01"},extendedDemo).find(group=>group.key==="taxi")!.amount));await expect(page.locator("article").last().getByRole("button",{name:"Choose a month",exact:true})).toHaveCount(0);await page.screenshot({path:`${output}/explicit-month-${colorScheme}.png`});
 }
 await context.setOffline(false);
});
