import {openOverview,expectExtendedSource} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {extendedDemo} from "../../src/engine/datasets";
import {lastMonth,summary,spendByCategory} from "../../src/engine";
import {money} from "../../src/lib/format";
const output=path.resolve(__dirname,"../../../../.impeccable/review/extended-data");
test("six-month source reaches every surface, survives refresh and stays isolated from the reference",async({page})=>{
 await page.setViewportSize({width:390,height:844});
 for(const colorScheme of ["light","dark"] as const){
  await page.emulateMedia({colorScheme,reducedMotion:"reduce"});await page.goto("/?dataset=extended");await page.evaluate(()=>{localStorage.removeItem("money-coach-data-scope.v1.extended");sessionStorage.clear();});await page.reload();
  await expectExtendedSource(page);await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total",String(summary(lastMonth,extendedDemo).expenses));
  await page.evaluate(()=>window.scrollTo({top:0,behavior:"instant"}));await page.screenshot({path:`${output}/overview-${colorScheme}.png`});await page.addScriptTag({path:require.resolve("axe-core")});expect(await page.evaluate(async()=>{const {axe}=window as unknown as {axe:typeof import("axe-core")};return (await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>v.id);})).toEqual([]);
  await page.getByRole("tab",{name:"Coach",exact:true}).click();await page.getByRole("textbox",{name:"Your question",exact:true}).fill("How much did I spend on taxis last month?");const request=page.waitForRequest(r=>r.url().endsWith("/api/chat") && r.method()==="POST");await page.getByRole("button",{name:"Send question",exact:true}).click();expect((await request).postDataJSON().dataset).toBe("extended");await expect(page.locator("article").last()).toContainText(money(spendByCategory(lastMonth,extendedDemo).find(g=>g.key==="taxi")!.amount));await page.screenshot({path:`${output}/coach-${colorScheme}.png`});
  const ids=await page.locator("article").evaluateAll(rows=>rows.map(row=>row.getAttribute("data-message-id")));await page.reload();await page.getByRole("tab",{name:"Coach",exact:true}).click();await expect(page.locator("article")).toHaveCount(2);expect(await page.locator("article").evaluateAll(rows=>rows.map(row=>row.getAttribute("data-message-id")))).toEqual(ids);
  for(const [tab,name] of [["What if","what-if"],["Learn","learn"]]){await page.getByRole("tab",{name:tab,exact:true}).click();await page.screenshot({path:`${output}/${name}-${colorScheme}.png`});}
  await page.getByRole("button",{name:"Settings",exact:true}).click();await page.screenshot({path:`${output}/settings-${colorScheme}.png`});await page.getByRole("button",{name:"What the coach can see",exact:true}).click();await page.getByRole("switch",{name:"Taxis",exact:true}).uncheck();await page.getByRole("button",{name:"Done",exact:true}).click();await page.getByRole("button",{name:"Overview",exact:true}).click();await page.getByRole("tab",{name:"Coach",exact:true}).click();await expect(page.locator("article")).toHaveCount(0);
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill("How much did I spend on taxis last month?");await page.getByRole("button",{name:"Send question",exact:true}).click();await expect(page.locator("article").last()).toContainText("No recorded transactions");
  await page.getByRole("button",{name:"Settings",exact:true}).click();await page.getByRole("radio",{name:"Small reference profile (13 transactions)",exact:true}).check();await page.getByRole("button",{name:"Overview",exact:true}).click();await expect(page.getByRole("button",{name:"3 to check",exact:true})).toBeVisible();await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","86450");
 }
});
test("long real-source category sheet windows rows and can reach both ends",async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?dataset=extended");await page.getByRole("tab",{name:"Coach",exact:true}).click();await page.getByRole("textbox",{name:"Your question",exact:true}).fill("Where did my money go from 2026-05-01 through 2026-11-04?");await page.getByRole("button",{name:"Send question",exact:true}).click();await page.locator("article").last().getByRole("button",{name:/Other categories/}).click();
 const sheet=page.getByRole("dialog",{name:"Other categories",exact:true}),list=sheet.getByRole("region",{name:"Transactions",exact:true});await expect(list).toBeVisible();await expect.poll(()=>list.locator("li").count()).toBeGreaterThan(0);expect(await list.locator("li").count()).toBeLessThan(50);
 await list.evaluate(node=>{node.scrollTop=node.scrollHeight;});await expect(list.getByText("1.5.2026",{exact:true})).toBeVisible();expect(await list.locator("li").count()).toBeLessThan(50);await page.screenshot({path:`${output}/virtual-list.png`});
 await sheet.getByRole("button",{name:"Use pages",exact:true}).click();await expect(sheet.getByRole("button",{name:"Next",exact:true})).toBeVisible();await expect(sheet.getByText(/Page 1 of/)).toBeVisible();
});
