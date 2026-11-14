import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {banks,mockBanks,signInBanks} from "./bank-support";

test("bank UI requires explicit account choice and distinguishes queued fetch from published observations",async ({page})=>{
  const state=await mockBanks(page);await signInBanks(page);
  await expect(page.getByText("No bank is connected yet.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:`Connect ${banks[0].name}`,exact:true}).click();
  await expect(page.getByRole("button",{name:"Allow selected accounts"})).toBeDisabled();
  await page.getByRole("checkbox",{name:/Everyday synthetic account/}).check();
  await page.getByRole("button",{name:"Allow selected accounts"}).click();
  await expect(page.getByText("Account access granted.",{exact:false})).toBeVisible();
  expect(state.calls[1].body.account_references).toEqual(["source-account"]);
  await page.getByRole("button",{name:`Refresh ${banks[0].name}`,exact:true}).click();
  await expect(page.locator(".bank-health")).toHaveText("Refresh queued or running");
  await expect(page.getByText("No published account source is attached to this connection.")).toBeVisible();
  state.publish();await page.clock.fastForward(5100);
  await expect(page.locator(".bank-health")).toHaveText("Published observation");
  await expect(page.getByText("Published source observed",{exact:true})).toBeVisible();
  await expect(page.getByText(/whole-finance or household coverage/)).toBeVisible();
  await page.getByRole("button",{name:`Disconnect ${banks[0].name}`,exact:true}).click();
  expect(state.calls.some(call=>call.path.endsWith("/disconnect"))).toBe(false);
  await page.getByRole("button",{name:"Confirm disconnect"}).click();
  await expect(page.getByText("Disconnected",{exact:true})).toBeVisible();
  await expect(page.getByText("Access required",{exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:`Connect ${banks[0].name}`,exact:true})).toBeEnabled();
});

for (const kind of ["start","complete"] as const) test(`lost ${kind} response retries exactly the original consent command without automatic replay`,async ({page})=>{
  const state=await mockBanks(page,kind==="start" ? {failStartOnce:true} : {failCompleteOnce:true});await signInBanks(page);
  await page.getByRole("button",{name:`Connect ${banks[0].name}`,exact:true}).click();
  if (kind==="complete") {await page.getByRole("checkbox").check();await page.getByRole("button",{name:"Allow selected accounts"}).click();}
  const retry=page.getByRole("button",{name:"Retry the same bank request"});await expect(retry).toBeVisible();
  const count=state.calls.length;await page.clock.fastForward(20000);expect(state.calls).toHaveLength(count);
  await expect(page.getByRole("button",{name:`Connect ${banks[1].name}`,exact:true})).toBeDisabled();
  await retry.click();await expect(retry).toHaveCount(0);
  expect(state.calls.at(-1)).toEqual(state.calls.at(-2));expect(state.connections).toHaveLength(1);
});

test("declining consent shares no accounts and offline lifecycle clears choices without replay",async ({page,context})=>{
  const state=await mockBanks(page);await signInBanks(page);
  await page.getByRole("button",{name:`Connect ${banks[1].name}`,exact:true}).click();
  await page.getByRole("checkbox").check();await page.getByRole("button",{name:"Decline account access"}).click();
  expect(state.calls.at(-1)?.body).toMatchObject({approved:false,account_references:[]});
  await expect(page.getByText("Access declined.",{exact:false})).toBeVisible();
  await page.getByRole("button",{name:`Connect ${banks[0].name}`,exact:true}).click();await page.getByRole("checkbox").check();
  await context.setOffline(true);await expect(page.getByText("You're offline.",{exact:false})).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);const count=state.calls.length;
  await context.setOffline(false);await expect(page.getByRole("heading",{name:"Your banks, in one place."})).toBeVisible();
  await expect(page.getByRole("checkbox")).toHaveCount(0);expect(state.calls).toHaveLength(count);
  await expect(page.getByRole("button",{name:"Cancel unfinished connection"})).toBeVisible();
});

test("bank source errors preserve dated evidence and layouts across desktop mobile and enlarged text",async ({page})=>{
  await mockBanks(page,{published:true,sourceError:true});await signInBanks(page);
  await expect(page.getByText("The source could not be refreshed completely.",{exact:false})).toBeVisible();
  await mkdir(".impeccable/review",{recursive:true});
  for (const [width,theme,name] of [[1440,"light","banks-desktop"],[320,"dark","banks-mobile"],[320,"light","banks-enlarged"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    if (name==="banks-enlarged") await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test("unavailable bank metadata has a recoverable state without offering writes",async ({page})=>{
  const state=await mockBanks(page,{unavailable:true});await signInBanks(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Connection status is unavailable");
  await expect(page.getByRole("button",{name:"Check bank status"})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Add a synthetic bank"})).toHaveCount(0);expect(state.calls).toHaveLength(0);
});

test("consent choice is keyboard focused, expires locally and never persists its callback token",async ({page})=>{
  const state=await mockBanks(page);await signInBanks(page);
  await page.getByRole("button",{name:`Connect ${banks[0].name}`,exact:true}).click();
  await expect(page.getByRole("heading",{name:`Choose accounts for ${banks[0].name}`})).toBeFocused();
  await page.getByRole("checkbox").check();
  for (const [width,theme,name] of [[1440,"light","banks-consent-desktop"],[320,"dark","banks-consent-mobile"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain("a".repeat(43));
  await page.clock.fastForward(11*60*1000);await expect(page.getByRole("button",{name:"Allow selected accounts"})).toBeDisabled();
  await expect(page.getByRole("button",{name:"Decline account access"})).toBeDisabled();
  expect(state.calls).toHaveLength(1);
});
