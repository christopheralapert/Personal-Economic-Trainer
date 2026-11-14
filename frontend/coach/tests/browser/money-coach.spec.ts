import {openOverview} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect,type Page} from "@playwright/test";
import path from "node:path";
const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("public PWA boots cold offline with session-only conversation and no cached chat requests",async({page,context})=>{
  await page.goto("/");
  await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    if(!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener("controllerchange",()=>resolve(),{once:true}));
  });
  const manifest=await (await page.request.get("/manifest.webmanifest")).json();
  expect(manifest.icons).toEqual(expect.arrayContaining([expect.objectContaining({sizes:"192x192",type:"image/png"}),expect.objectContaining({sizes:"512x512",purpose:"maskable"})]));
  await page.getByRole("tab",{name:"Coach",exact:true}).click();
  await ask(page,"How much did I spend on taxis last month?");
  await context.setOffline(true);
  await page.reload();await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","86450");
  await page.getByRole("tab",{name:"Coach",exact:true}).click();await expect(page.locator("article")).toHaveCount(2);await expect(page.locator("article").last()).toContainText("40,00");
  await ask(page,"What if I cut dining out by 20%?");await expect(page.locator("article").last()).toContainText("50,00");
  await ask(page,'Paljonko kulutin takseihin paikassa "Helsinki" lokakuussa?');await expect(page.locator("article").last()).toContainText("18,90");
  await ask(page,"Mis siis, kui vähendan restoranikulusid 20% võrra oktoobris?");await expect(page.locator("article").last()).toContainText("50,00");
  await page.goto("/kit");await expect(page.locator("[data-component]")).toHaveCount(15);
  const urls=await page.evaluate(async()=>{
    const names=(await caches.keys()).filter(name=>name.startsWith("money-coach-public-"));
    const stored=await Promise.all(names.map(async name=>(await (await caches.open(name)).keys()).map(request=>new URL(request.url).pathname)));
    return stored.flat();
  });
  expect(urls).toContain("/");expect(urls).toContain("/kit");expect(urls).not.toContain("/month");expect(urls.some(url=>url.startsWith("/_next/static/"))).toBe(true);
  expect(urls.some(url=>url.startsWith("/api/") || url.includes("?"))).toBe(false);
  await context.setOffline(false);
});
async function ask(page:Page,question:string) {
  await page.getByRole("textbox",{name:"Your question",exact:true}).fill(question);
  await page.getByRole("button",{name:"Send question",exact:true}).click();
  await checkBasis(page,page.locator("article").last());
}
test("native SDK stream returns actual tool figures, no model; offline fallback, sliders, locales and all kit entries work",async({page,context})=>{
  const navigation=await page.goto("/");const headers={"X-Money-Coach-Revision":navigation!.headers()["x-money-coach-revision"]};
  expect(headers["X-Money-Coach-Revision"]).toMatch(/^[a-f0-9]{64}$/);
  await openOverview(page);await expect(page.locator("[data-chart-total]")).toHaveAttribute("data-chart-total","86450");
  await page.getByRole("tab",{name:"Coach",exact:true}).click();
  await ask(page,"How much did I spend on taxis last month?");await expect(page.locator("article")).toContainText(["How much did I spend","40,00"]);
  await expect(page.getByText("The online response was unavailable.",{exact:false})).toHaveCount(0);
  await expect(page.getByText("Taxi Helsinki",{exact:true})).toBeVisible();
  const nextRequest=page.waitForRequest(request=>request.url().endsWith("/api/chat") && request.method()==="POST");
  await ask(page,"What if I cut dining out by 20%?");await expect(page.locator("article").last()).toContainText("50,00");
  const sent=(await nextRequest).postDataJSON();expect(sent.messages).toEqual([{role:"user",parts:[{type:"text",text:"What if I cut dining out by 20%?"}]}]);expect(sent.locale).toBe("en");expect(sent.savingsPercent).toBe(10);
  const slider=page.getByRole("slider");await slider.focus();await page.keyboard.press("ArrowRight");await expect(page.locator("article").last()).toContainText("52,50");
  await context.setOffline(true);await ask(page,"What kind of spender am I?");await expect(page.getByText("The online response was unavailable.",{exact:false})).toBeVisible();await context.setOffline(false);
  await context.route("**/api/chat",route=>route.continue({headers:{...route.request().headers(),"x-money-coach-revision":"obsolete-client"}}));
  const stale=page.waitForResponse(response=>response.url().endsWith("/api/chat") && response.status()===409);
  await ask(page,"How much did I spend on taxis last month?");await stale;
  await expect(page.locator("article").last()).toContainText("40,00");await expect(page.getByText("The online response was unavailable.",{exact:false})).toBeVisible();
  await context.unroute("**/api/chat");
  await page.getByRole("tab",{name:"What if",exact:true}).click();await expect(page.getByRole("slider")).toHaveCount(1);await expect(page.getByRole("group",{name:"Category",exact:true}).getByRole("button")).toHaveCount(3);
  await page.getByRole("button",{name:"Settings",exact:true}).click();await page.getByLabel("Eesti",{exact:true}).check();await expect(page.getByRole("heading",{name:"Seaded",exact:true})).toBeVisible();
  await page.getByLabel("English",{exact:true}).check();
  await page.getByRole("button",{name:"Set a savings goal",exact:true}).click();await page.getByLabel("Goal name",{exact:true}).fill("Buffer");await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByLabel("Target amount in EUR",{exact:true}).fill("100,50");await page.getByRole("button",{name:"Continue",exact:true}).click();await page.getByRole("button",{name:"Save goal",exact:true}).click();await expect(page.getByText("Buffer · 100,50",{exact:false})).toBeVisible();
  await page.goto("/kit");await expect(page.locator("[data-component]")).toHaveCount(15);await expect(page.locator("[data-component=showDonut] svg.recharts-surface")).toBeVisible();
  await page.getByRole("button",{name:"Filter transactions",exact:true}).click();await page.getByLabel("Reserved",{exact:true}).check();await page.getByRole("button",{name:"Done",exact:true}).click();await expect(page.getByRole("dialog")).toHaveCount(0);
  const response=await page.request.post("/api/chat",{headers,data:{messages:[{role:"user",parts:[{type:"text",text:"What is safe for me to spend this week?"}]}]}});expect(response.status()).toBe(200);expect(response.headers()["content-type"]).toContain("text/event-stream");const stream=await response.text();expect(stream).toContain('"toolName":"showSafeToSpend"');expect(stream).toContain('"amount":null');
  for(const [options,status] of [
    [{data:"{}",headers:{"content-type":"text/plain"}},415],
    [{data:" ".repeat(65537),headers:{"content-type":"application/json"}},413],
    [{data:{messages:[{role:"user",parts:[{type:"file",url:"ignored-scope"}]}]}},400],
  ] as const) {
    const rejected=await page.request.post("/api/chat",{...options,headers:{...headers,...("headers" in options ? options.headers : {})}});expect(rejected.status()).toBe(status);expect(rejected.headers()["cache-control"]).toBe("private, no-store");
  }
  for(const [question,expectedTool,expectedText] of [
    ['How much did I spend on taxis at "Helsinki" last month?',"showTransactions","18,90"],
    ['Kui palju maksin taksole kaupmehelt "Helsinki" oktoobris?',"showTransactions","18,90"],
    ["Mitä jos vähennän ravintolakuluja 20% lokakuussa?","showWhatIf","50,00"],
    ["What if I cut dining out by 20% and coffee by 50%?",null,"Choose a valid period"],
    ['What if I cut category "absent" by 20% last month?',null,"Not available"],
    ["What if I cut dining out by 20% last week?",null,"Choose one calendar month"],
    ["Compare me to others this month",null,"Choose one calendar month"],
  ] as const) {
    const actual=await page.request.post("/api/chat",{headers,data:{messages:[{role:"user",parts:[{type:"text",text:question}]}]}});
    expect(actual.status()).toBe(200);const body=await actual.text();expect(body).toContain(expectedText);
    if(expectedTool) {expect(body).toContain(`"toolName":"${expectedTool}"`);expect(body).not.toContain("City taxi");}
    else expect(body).not.toContain('"toolName"');
  }
});

test("responsive light/dark screenshot batch and enlarged text",async({page})=>{
  for(const scheme of ["light","dark"] as const) {
    await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:scheme,reducedMotion:"reduce"});await page.goto("/");
    await page.screenshot({path:`${captures}/overview-${scheme}.png`,fullPage:true});await page.screenshot({path:`${captures}/overview-${scheme}-viewport.png`});
    await page.getByRole("tab",{name:"Coach",exact:true}).click();
    await ask(page,"How much did I spend on taxis last month?");await ask(page,"What if I cut dining out by 20%?");await ask(page,"Where did my money go last month?");
    await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();window.scrollTo({top:0,behavior:"instant"});});
    await page.screenshot({path:`${captures}/coach-${scheme}.png`,fullPage:true});await page.screenshot({path:`${captures}/coach-${scheme}-viewport.png`});
    await page.getByRole("tab",{name:"What if",exact:true}).click();await page.evaluate(()=>window.scrollTo({top:0,behavior:"instant"}));await page.screenshot({path:`${captures}/whatif-${scheme}.png`,fullPage:true});await page.screenshot({path:`${captures}/whatif-${scheme}-viewport.png`});
  }
  for(const width of [360,430,768]) {await page.setViewportSize({width,height:844});await page.goto("/");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${captures}/overview-${width}.png`,fullPage:true});}
  await page.setViewportSize({width:360,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:`${captures}/overview-enlarged.png`,fullPage:true});
});
