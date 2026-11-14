import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {mockImports,openImportFiles,chooseImportFiles,createAndUpload,finishToPublication,nativeAccount,manifest,capabilityMarker} from "./import-support";

test.beforeAll(async()=>{await mkdir(".impeccable/review",{recursive:true});});

test("native source journey streams files and requires separate row and publication choices",async ({page})=>{
  await page.addInitScript(()=>{
    const original=File.prototype.text;
    File.prototype.text=function(){if (this.name.endsWith(".csv")) throw new Error("CSV must not be read wholesale in JavaScript");return original.call(this);};
  });
  const state=await mockImports(page);await openImportFiles(page);await finishToPublication(page,state);
  expect(state.uploads).toHaveLength(3);
  expect(state.calls.some(call=>call.path.endsWith("/publication"))).toBe(false);
  await page.getByRole("button",{name:"Use checked data",exact:true}).click();
  await expect(page.getByRole("button",{name:"Cancel this change",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Explore your imported entries"})).toHaveCount(0);
  state.finishPublication();await page.clock.fastForward(5100);
  await expect(page.getByRole("heading",{name:"Explore your imported entries"})).toBeVisible();
  await expect(page.locator(".import-history>li").first()).toContainText("Ready for analysis");
  await page.getByLabel("Source account",{exact:true}).selectOption(nativeAccount);
  await page.getByLabel("Merchant contains",{exact:true}).fill("Synthetic");
  await page.getByRole("button",{name:"Find source records",exact:true}).click();
  await expect(page.locator(".import-record-list>li")).toHaveCount(2);
  await expect(page.locator(".import-record-amount").first()).toContainText("1,25");
  await page.getByRole("button",{name:"Next source records",exact:true}).click();
  await expect(page.getByRole("button",{name:"Next source records",exact:true})).toHaveCount(0);
  expect(await page.content()).not.toContain(capabilityMarker);
  expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(manifest.source_customer_ref);
  await mkdir(".impeccable/review",{recursive:true});
  for (const [width,theme,name] of [[1440,"light","imports-desktop"],[360,"dark","imports-mobile"],[320,"light","imports-enlarged"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});
    if (name==="imports-enlarged") await page.evaluate(()=>{document.documentElement.style.fontSize="200%";});
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
});

test("lost manifest response retains one exact manual retry and sends no files automatically",async ({page})=>{
  const state=await mockImports(page,{loseCreate:true});await openImportFiles(page);await chooseImportFiles(page);
  await page.getByRole("button",{name:"Prepare private upload",exact:true}).click();
  const retry=page.getByRole("button",{name:"Retry the same import request",exact:true});await expect(retry).toBeVisible();
  const count=state.calls.length;await page.clock.fastForward(20000);expect(state.calls).toHaveLength(count);expect(state.uploads).toHaveLength(0);
  await expect(page.getByRole("button",{name:"Prepare private upload",exact:true})).toBeDisabled();
  await retry.click();await expect(retry).toHaveCount(0);
  expect(state.calls.at(-1)).toEqual(state.calls.at(-2));
  await expect(page.getByRole("button",{name:"Upload and check files",exact:true})).toBeEnabled();
  expect(state.uploads).toHaveLength(0);
});

test("lost publication response never auto-publishes twice and reads the actual completed status",async ({page})=>{
  const state=await mockImports(page,{losePublication:true});await openImportFiles(page);await finishToPublication(page,state);
  await page.getByRole("button",{name:"Use checked data",exact:true}).click();
  const retry=page.getByRole("button",{name:"Retry the same import request",exact:true});await expect(retry).toBeVisible();
  const count=state.calls.length;state.finishPublication();await page.clock.fastForward(20000);
  expect(state.calls).toHaveLength(count);await retry.click();
  await expect(page.getByRole("heading",{name:"Explore your imported entries"})).toBeVisible();
  expect(state.calls.at(-1)).toEqual(state.calls.at(-2));
  await expect(page.getByRole("button",{name:"Use checked data",exact:true})).toHaveCount(0);
});

test("closing or going offline aborts uploads and reconnect restores history without file handles or replay",async ({page,context})=>{
  const state=await mockImports(page,{stallUpload:true});await openImportFiles(page);await createAndUpload(page);
  await expect.poll(()=>state.uploads.some(upload=>upload.role==="transactions")).toBe(true);
  await context.setOffline(true);await expect(page.getByText("You're offline.",{exact:false})).toBeVisible();
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  const writes=state.calls.length;state.releaseUpload();await context.setOffline(false);
  await expect(page.getByRole("heading",{name:"Your banks, in one place."})).toBeVisible();
  await page.getByText("Your data files",{exact:true}).click();
  await page.getByRole("button",{name:`Open source ${manifest.source_version}`,exact:true}).click();
  await expect(page.getByRole("button",{name:"Upload and check files",exact:true})).toBeDisabled();
  expect(await page.locator("input[type=file]").evaluateAll(inputs=>inputs.every(input=>(input as HTMLInputElement).files?.length===0))).toBe(true);
  expect(state.calls).toHaveLength(writes);expect(state.calls.some(call=>call.path.endsWith("/submit"))).toBe(false);
  expect(await page.content()).not.toContain(capabilityMarker);
});

test("source errors show private rejection references without presenting unchecked rows as published",async ({page})=>{
  const state=await mockImports(page,{invalidRows:true});await openImportFiles(page);await createAndUpload(page);
  await expect.poll(()=>state.calls.some(call=>call.path.endsWith("/submit"))).toBe(true);
  state.finishFiles();await page.clock.fastForward(5100);await page.getByRole("button",{name:"Check source rows",exact:true}).click();
  state.finishRows();await page.clock.fastForward(5100);
  await expect(page.locator(".import-state")).toHaveText("Source needs correction");
  await expect(page.getByRole("button",{name:"Use checked data",exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Read source issues",exact:true}).click();
  await expect(page.getByText("Use canonical whole minor units, without decimal fractions or exponents.",{exact:true})).toBeVisible();
  expect(state.calls.some(call=>call.path.endsWith("/publication"))).toBe(false);
  await page.setViewportSize({width:320,height:1000});await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:".impeccable/review/imports-issues.png",fullPage:true,animations:"disabled"});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("file controls stay responsive and eligibility change clears the same session's draft",async ({page})=>{
  const state=await mockImports(page);await openImportFiles(page);await chooseImportFiles(page);
  for (const [width,theme,name] of [[1440,"light","imports-upload-desktop"],[320,"dark","imports-upload-mobile"]] as const) {
    await page.setViewportSize({width,height:1000});await page.emulateMedia({colorScheme:theme});await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  state.revokeEligibility();await page.clock.fastForward(16000);
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await page.getByText("Your data files",{exact:true}).click();
  await expect(page.getByText("File import is unavailable here. Existing imports can still be reviewed.",{exact:true})).toBeVisible();
  await expect(page.getByLabel("Export manifest (JSON, up to 8 KiB)")).toBeDisabled();
  await expect(page.getByRole("heading",{name:manifest.source_version,exact:true})).toHaveCount(0);
  expect(state.calls).toHaveLength(0);
});

test("unsupported or oversized manifests fail before an upload request is created",async ({page})=>{
  const state=await mockImports(page);await openImportFiles(page);
  const input=page.getByLabel("Export manifest (JSON, up to 8 KiB)");
  await input.setInputFiles({name:"manifest.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({...manifest,owner_user_id:"forged"}))});
  await expect(page.getByRole("main").getByRole("alert")).toContainText("compatible export");expect(state.calls).toHaveLength(0);
  await input.setInputFiles({name:"manifest.json",mimeType:"application/json",buffer:Buffer.alloc(8193,32)});
  await expect(page.getByRole("main").getByRole("alert")).toContainText("larger than 8 KiB");expect(state.calls).toHaveLength(0);
});
