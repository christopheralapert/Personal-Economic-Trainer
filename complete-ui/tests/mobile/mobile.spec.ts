import {openOverview} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect,type Locator,type Page} from "@playwright/test";
import path from "node:path";

const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");
async function withinViewport(locator:Locator,page:Page) {
  await expect(async()=>{
    const bounds=await locator.boundingBox();expect(bounds).not.toBeNull();
    const viewport=await page.evaluate(()=>({top:visualViewport?.offsetTop ?? 0,bottom:(visualViewport?.offsetTop ?? 0)+(visualViewport?.height ?? innerHeight)}));
    expect(bounds!.y).toBeGreaterThanOrEqual(viewport.top-1);
    expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(viewport.bottom+1);
  }).toPass({timeout:5000});
}

test("touch navigation, narrow and landscape chat, simulator and bottom sheet",async({page},testInfo)=>{
  const errors:string[]=[];page.on("pageerror",error=>errors.push(error.name));
  await page.goto("/");await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","86450");
  await page.getByRole("tab",{name:"Coach",exact:true}).tap();
  const input=page.getByRole("textbox",{name:"Your question",exact:true});
  const send=page.getByRole("button",{name:"Send question",exact:true});
  for(const width of [360,390,430]) {
    await page.setViewportSize({width,height:664});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await withinViewport(input,page);await withinViewport(send,page);
  }
  await input.tap();await input.fill("How much did I spend on taxis last month?");
  // A resized layout models adjustResize-style hosts; it does not open a native keyboard.
  await page.setViewportSize({width:390,height:400});
  await withinViewport(input,page);await withinViewport(send,page);
  const reply=page.waitForResponse(response=>response.url().endsWith("/api/chat") && response.request().method()==="POST");
  await send.tap();expect((await reply).headers()["x-money-coach-source"]).toBe("rule");
  await expect(page.locator("article").last()).toContainText("40,00");
  await page.setViewportSize({width:844,height:390});await withinViewport(input,page);
  await page.screenshot({path:`${captures}/mobile-${testInfo.project.name}-landscape.png`});
  await page.getByRole("tab",{name:"What if",exact:true}).tap();
  const slider=page.getByRole("slider").first(),track=page.locator('[data-slot="slider"]').first();
  await track.evaluate(node=>node.scrollIntoView({block:"center",behavior:"instant"}));
  const box=await track.boundingBox();expect(box).not.toBeNull();
  expect(await page.evaluate(({x,y})=>Boolean(document.elementFromPoint(x,y)?.closest('[data-slot="slider"]')),{x:box!.x+box!.width*.75,y:box!.y+box!.height/2})).toBe(true);
  await page.touchscreen.tap(box!.x+box!.width*.75,box!.y+box!.height/2);
  await expect(slider).not.toHaveAttribute("aria-valuenow","20");
  await page.setViewportSize({width:390,height:664});await page.goto("/kit");
  const filter=page.getByRole("button",{name:"Filter transactions",exact:true});await filter.tap();
  const sheet=page.getByRole("dialog");await expect(sheet).toBeVisible();await withinViewport(sheet,page);
  await sheet.getByLabel("Reserved",{exact:true}).tap();
  const done=sheet.getByRole("button",{name:"Done",exact:true});
  await withinViewport(done,page);await done.tap();
  await expect(sheet).toHaveCount(0);await expect(filter).toBeFocused();expect(errors).toEqual([]);
});

test("visual-only keyboard resize and pan keep the composer usable without treating zoom as a keyboard",async({page},testInfo)=>{
  // Deliberately synthetic: desktop WebKit/Chrome cannot show a real OS keyboard.
  await page.addInitScript(()=>{
    const viewport=Object.assign(new EventTarget(),{height:innerHeight,width:innerWidth,offsetTop:0,offsetLeft:0,scale:1});
    Object.defineProperty(window,"visualViewport",{configurable:true,value:viewport});
  });
  await page.goto("/");await page.getByRole("tab",{name:"Coach",exact:true}).tap();
  const input=page.getByRole("textbox",{name:"Your question",exact:true});
  const send=page.getByRole("button",{name:"Send question",exact:true});
  await input.tap();await input.fill("What kind of spender am I?");
  async function resize(height:number,offsetTop=0,scale=1) {
    await page.evaluate(({height,offsetTop,scale})=>{
      Object.assign(visualViewport!,{height,offsetTop,scale});visualViewport!.dispatchEvent(new Event("resize"));visualViewport!.dispatchEvent(new Event("scroll"));
    },{height,offsetTop,scale});
  }
  await resize(400);
  await expect.poll(async()=>{const box=await send.boundingBox();return box!.y+box!.height;}).toBeLessThanOrEqual(401);
  await withinViewport(input,page);
  for(const tab of await page.getByRole("tab").all()) await withinViewport(tab,page);
  await page.screenshot({path:`${captures}/mobile-${testInfo.project.name}-keyboard.png`});
  await resize(360,40);await withinViewport(input,page);await withinViewport(send,page);
  await resize(300,0,1.5);
  await expect.poll(()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue("--keyboard-inset").trim())).toBe("0px");
  await resize(400);await withinViewport(send,page);await send.tap();
  await checkBasis(page,page.locator("article").last());
  await resize(page.viewportSize()!.height);await withinViewport(input,page);
  await page.getByRole("button",{name:"Settings",exact:true}).tap();
  await expect.poll(()=>page.evaluate(()=>document.documentElement.style.getPropertyValue("--keyboard-inset"))).toBe("");
});
