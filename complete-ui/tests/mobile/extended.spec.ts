import {expectExtendedSource} from "../view-navigation";
import {test,expect} from "@playwright/test";
import {extendedDemo} from "../../src/engine/datasets";
import {lastMonth,spendByCategory,simulateReduction} from "../../src/engine";
import {money} from "../../src/lib/format";
test("six-month profile retains offline financial figures and usable touch controls",async({page,context})=>{
 await page.goto("/?dataset=extended");await expectExtendedSource(page);await page.evaluate(async()=>{await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener("controllerchange",()=>resolve(),{once:true}));});
 await context.setOffline(true);await page.reload();await page.getByRole("tab",{name:"Coach",exact:true}).tap();await page.getByRole("textbox",{name:"Your question",exact:true}).fill("How much did I spend on taxis last month?");await page.getByRole("button",{name:"Send question",exact:true}).tap();await expect(page.locator("article").last()).toContainText(money(spendByCategory(lastMonth,extendedDemo).find(g=>g.key==="taxi")!.amount));
 // Exact physical-phone report: manual typo must work with no network or API key.
 await page.getByRole("textbox",{name:"Your question",exact:true}).fill("What if i cut dinig out by 20%?");await page.getByRole("button",{name:"Send question",exact:true}).tap();
 await expect(page.locator("article").last()).toContainText(money(simulateReduction("dining",20,lastMonth,extendedDemo).monthly));
 await expect(page.locator("article").last()).not.toContainText("Choose a valid period");
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await context.setOffline(false);
});
