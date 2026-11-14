import {openOverview,openRecords} from "../view-navigation";
import {test,expect} from "@playwright/test";

test("touch safe-saving review opens its explanation and local goal without a money action",async({page})=>{
  await page.goto("/?question="+encodeURIComponent("What is safe for me to save this month?"));
  await page.getByRole("button",{name:"Send question",exact:true}).tap();const answer=page.locator("article").last();
  await expect(answer).toContainText("Extra saving room");await expect(answer).not.toContainText("Add your monthly income");
  await answer.getByRole("button",{name:"How is this calculated?",exact:true}).tap();await expect(page.getByRole("dialog")).toContainText("Illustrative headroom after recorded reserves");await page.getByRole("dialog").getByRole("button",{name:"Done",exact:true}).tap();
  const action=answer.getByRole("button",{name:"Set a savings goal",exact:true});await action.evaluate(node=>node.scrollIntoView({block:"center",behavior:"instant"}));await action.tap();
  await expect(page.getByRole("textbox",{name:"Goal name",exact:true})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("touch basket exploration and profile evidence preserve source scope",async({page})=>{
  await page.goto("/");await page.locator('[data-overview-block="baskets"]').getByRole("button",{name:/Regular/}).tap();
  await page.locator("#learn-mandatory_regular").getByRole("button").tap();
  await expect(page.locator("article").last()).toContainText("350,00");
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill("What kind of spender am I?");
  await page.getByRole("button",{name:"Send question",exact:true}).tap();
  const action=page.locator("article").last().getByRole("button",{name:"View transactions for Home",exact:true});
  await action.evaluate(node=>node.scrollIntoView({block:"center",behavior:"instant"}));await action.tap();
  await expect(page.locator("article").last()).toContainText("350,00");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("touch reversed-status sheet keeps its confirmation reachable in landscape",async({page})=>{
  await page.setViewportSize({width:844,height:390});await page.goto("/");await openRecords(page);await page.getByRole("button",{name:"Filter transactions",exact:true}).tap();
  const sheet=page.getByRole("dialog");await sheet.getByRole("radio",{name:"Reversed",exact:true}).tap();
  const done=sheet.getByRole("button",{name:"Done",exact:true});await expect.poll(async()=>{const bounds=await done.boundingBox();return bounds!.y+bounds!.height;}).toBeLessThanOrEqual(391);await done.tap();
  await expect(page.getByText("No recorded transactions in this scope.",{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("touch monthly scenarios retain their selection and values across navigation",async({page})=>{
  await page.goto("/");await page.getByRole("tab",{name:"What if",exact:true}).tap();
  await page.getByRole("button",{name:"Previous calendar month",exact:true}).last().tap();
  const combined=page.getByRole("region",{name:"Combined reduction",exact:true});await expect(combined).toContainText("50,00");
  const track=page.locator('[data-slot="slider"]').first();await track.evaluate(node=>node.scrollIntoView({block:"center",behavior:"instant"}));const bounds=await track.boundingBox();
  const point={x:bounds!.x+bounds!.width*.75,y:bounds!.y+bounds!.height/2};expect(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('[data-slot="slider"]')),point)).toBe(true);
  await page.touchscreen.tap(point.x,point.y);const value=await page.getByRole("slider").first().getAttribute("aria-valuenow");expect(value).not.toBe("20");
  await page.getByRole("tab",{name:"Learn",exact:true}).tap();await page.getByRole("tab",{name:"What if",exact:true}).tap();await expect(page.getByRole("slider").first()).toHaveAttribute("aria-valuenow",value!);await expect(page.getByText("September 2026",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"Reset to 20%",exact:true}).tap();await expect(combined).toContainText("50,00");
});

test("touch learning handoff and editable goal stay usable on mobile engines",async({page})=>{
  let calls=0;page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) calls++;});
  await page.goto("/");await page.getByRole("tab",{name:"Learn",exact:true}).tap();
  await page.getByRole("button",{name:/A small change/}).tap();
  const question=page.getByRole("textbox",{name:"Your question",exact:true});
  await expect(question).toHaveValue("");await expect(page.locator("article").last()).toContainText("50,00");expect(calls).toBe(1);
  await page.getByRole("button",{name:"Settings",exact:true}).tap();
  await page.getByRole("button",{name:"Set a savings goal",exact:true}).tap();
  const name=page.getByLabel("Goal name",{exact:true}),amount=page.getByLabel("Target amount in EUR",{exact:true});
  await name.fill("Mobile buffer");await page.getByRole("button",{name:"Continue",exact:true}).tap();
  await expect(amount).toBeFocused();await amount.fill("50,01");await page.getByRole("button",{name:"Continue",exact:true}).tap();
  await expect(page.locator("form")).toContainText("50,01");
  await page.getByRole("button",{name:"Save goal",exact:true}).tap();
  await page.getByRole("button",{name:"Edit savings goal",exact:true}).tap();
  await expect(name).toHaveValue("Mobile buffer");await page.getByRole("button",{name:"Continue",exact:true}).tap();
  await expect(amount).toHaveValue("50,01");
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(calls).toBe(1);
});

test("touch date presets require confirmation and stop at the snapshot",async({page})=>{
 await page.goto('/?question='+encodeURIComponent('Where did my money go last month?'));await page.getByRole('button',{name:'Send question',exact:true}).tap();const answer=page.locator('article').last(),trigger=answer.getByRole('button',{name:'Choose period',exact:true});await trigger.tap();const sheet=page.getByRole('dialog');await sheet.getByRole('button',{name:'Snapshot month to date',exact:true}).tap();await expect(answer).toContainText('864,50');await expect(sheet.getByLabel('Through',{exact:true})).toHaveValue('2026-11-04');await sheet.getByRole('button',{name:'Show period',exact:true}).tap();await expect(answer).toContainText('12,50');await trigger.tap();await sheet.getByRole('button',{name:'Previous calendar month',exact:true}).last().tap();await sheet.getByRole('button',{name:'Show period',exact:true}).tap();await expect(answer).toContainText('864,50');
});

test("touch history search and simulator reset preserve the source totals",async({page})=>{
  await page.goto("/");await openRecords(page);
  await page.getByRole("searchbox",{name:"Search merchant or category",exact:true}).fill("helsinki");
  await expect(page.getByText("Taxi Helsinki",{exact:true})).toBeVisible();await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","86450");await page.getByRole("tab",{name:"Coach",exact:true}).tap();
  await page.getByRole("button",{name:"Clear search",exact:true}).tap();
  await page.getByRole("tab",{name:"What if",exact:true}).tap();
  const slider=page.getByRole("slider",{name:"Reduce by Dining out",exact:true});
  const track=page.locator('[data-slot="slider"]').first();await track.evaluate(node=>node.scrollIntoView({block:"center",behavior:"instant"}));const bounds=await track.boundingBox();
  expect(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('[data-slot="slider"]')),{x:bounds!.x+bounds!.width*.75,y:bounds!.y+bounds!.height/2})).toBe(true);
  await page.touchscreen.tap(bounds!.x+bounds!.width*.75,bounds!.y+bounds!.height/2);await expect(slider).not.toHaveAttribute("aria-valuenow","20");
  await page.getByRole("button",{name:"Reset to 20%",exact:true}).tap();await expect(slider).toHaveAttribute("aria-valuenow","20");
  await expect(page.getByRole("region",{name:"Combined reduction",exact:true})).toContainText("61,30");
});
