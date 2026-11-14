import {test,expect} from "@playwright/test";
import path from "node:path";
const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");
test("settings show source-backed mock banks and capability-gated install states across languages and widths",async({page})=>{
  // Synthetic browser capability events exercise UI states without installing an OS app.
  await page.addInitScript(()=>window.addEventListener("beforeinstallprompt",event=>{if(event.isTrusted) event.stopImmediatePropagation();}));
  await page.setViewportSize({width:390,height:844});await page.goto("/");
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  const banks=page.getByRole("region",{name:"Connected banks",exact:true});
  await expect(banks).toContainText("S-Bank demo");await expect(banks).toContainText("North demo bank");
  await expect(banks).toContainText("500,00");await expect(banks).toContainText("300,00");
  await expect(banks.getByText("Demo only",{exact:true})).toHaveCount(2);
  const install=page.getByRole("region",{name:"Add to your home screen",exact:true});
  await expect(install.getByRole("button",{name:"Install Money Coach",exact:true})).toHaveCount(0);
  await install.getByRole("button",{name:"How to install",exact:true}).click();
  await expect(install).toContainText("Some browsers and embedded views do not offer installation");
  await page.evaluate(()=>{
    const state={calls:0,resolve:null as null|((value:{outcome:"dismissed"})=>void)};
    const event=new Event("beforeinstallprompt",{cancelable:true});
    Object.assign(event,{prompt:async()=>{state.calls++;},userChoice:new Promise(resolve=>{state.resolve=resolve;})});
    Object.assign(window,{installTest:state});window.dispatchEvent(event);
  });
  const action=install.getByRole("button",{name:"Install Money Coach",exact:true});await expect(action).toBeEnabled();
  await page.screenshot({path:`${captures}/settings-install-available-light.png`,fullPage:true});
  await action.click();await expect(action).toBeDisabled();
  expect(await page.evaluate(()=>(window as unknown as {installTest:{calls:number}}).installTest.calls)).toBe(1);
  await page.evaluate(()=>(window as unknown as {installTest:{resolve:(value:{outcome:"dismissed"})=>void}}).installTest.resolve({outcome:"dismissed"}));
  await expect(install).toContainText("Installation dismissed");await expect(action).toHaveCount(0);
  await page.evaluate(()=>{
    const event=new Event("beforeinstallprompt",{cancelable:true});Object.assign(event,{prompt:async()=>{throw new Error("Local simulated browser refusal");},userChoice:Promise.resolve({outcome:"accepted"})});window.dispatchEvent(event);
  });
  await action.click();await expect(install).toContainText("Installation could not start");await expect(action).toHaveCount(0);
  await page.evaluate(()=>{
    const event=new Event("beforeinstallprompt",{cancelable:true});Object.assign(event,{prompt:async()=>{},userChoice:Promise.resolve({outcome:"accepted"})});window.dispatchEvent(event);
  });
  await action.click();await expect(install).toContainText("Installation accepted");await expect(install.getByText("Money Coach is installed.",{exact:true})).toHaveCount(0);
  await page.evaluate(()=>window.dispatchEvent(new Event("appinstalled")));await expect(install).toContainText("Money Coach is installed.");
  for(const [width,scheme,language,enlarged] of [[390,"dark","Eesti",false],[360,"light","Eesti",true],[430,"dark","Suomi",false],[768,"light","English",false]] as const) {
    await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme:scheme,reducedMotion:"reduce"});await page.getByLabel(language,{exact:true}).check();
    await page.evaluate(large=>{document.documentElement.style.fontSize=large ? "130%" : "100%";window.scrollTo(0,0);},enlarged);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`${captures}/settings-${width}-${scheme}${enlarged ? "-enlarged" : ""}.png`,fullPage:true});
  }
});
