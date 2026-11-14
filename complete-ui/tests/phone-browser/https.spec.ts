import {test,expect,devices} from "@playwright/test";
import {readFile} from "node:fs/promises";
import {X509Certificate,createHash} from "node:crypto";
import {request} from "node:https";
import path from "node:path";

test("real HTTPS serves the public PWA and RuleProvider with the exact local certificate",async({playwright,baseURL})=>{
  const directory=path.resolve(__dirname,"../../../../.cache/money-coach-phone/127.0.0.1");
  const ca=await readFile(path.join(directory,"ca.pem")),leaf=new X509Certificate(await readFile(path.join(directory,"server.pem")));
  // Verify the actual hostname/chain before using a scoped browser certificate pin.
  const checked=await new Promise<number|undefined>((resolve,reject)=>{
    const req=request(baseURL!,{ca,rejectUnauthorized:true},response=>{response.resume();response.once("end",()=>resolve(response.statusCode));});req.once("error",reject);req.end();
  });expect(checked).toBe(200);
  const pin=createHash("sha256").update(leaf.publicKey.export({type:"spki",format:"der"})).digest("base64");
  const browser=await playwright.chromium.launch({channel:process.env.CI ? undefined : "chrome",args:[`--ignore-certificate-errors-spki-list=${pin}`]});
  try {
    const context=await browser.newContext({...devices["Pixel 7"],baseURL});const page=await context.newPage();
    await page.goto("/");expect(await page.evaluate(()=>isSecureContext)).toBe(true);
    await page.evaluate(async()=>{
      await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener("controllerchange",()=>resolve(),{once:true}));
    });
    await page.getByRole("tab",{name:"Coach",exact:true}).tap();
    await page.getByRole("textbox",{name:"Your question",exact:true}).fill("How much did I spend on taxis last month?");
    const reply=page.waitForResponse(response=>response.url().endsWith("/api/chat"));
    await page.getByRole("button",{name:"Send question",exact:true}).tap();
    expect((await reply).headers()["x-money-coach-source"]).toBe("rule");
    await expect(page.locator("article").last()).toContainText("40,00");
    await context.setOffline(true);await page.reload();await page.getByRole("tab",{name:"Coach",exact:true}).tap();
    await expect(page.locator("article")).toHaveCount(0);
    await page.getByRole("textbox",{name:"Your question",exact:true}).fill("What if I cut dining out by 20%?");
    await page.getByRole("button",{name:"Send question",exact:true}).tap();await expect(page.locator("article").last()).toContainText("50,00");
    await context.setOffline(false);
  } finally {await browser.close();}
});
