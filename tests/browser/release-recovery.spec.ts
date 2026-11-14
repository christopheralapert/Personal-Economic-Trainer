import {test,expect} from "@playwright/test";
import {ledger,signin,stageCanonical,submitRecords} from "./release-support";

test("atomic failed confirmation, retry/concurrent double-confirm and same-tab owner switching",async({page},info)=>{
 const first=await signin(page,"release-recovery"),before=await ledger(page);
 const beforeAccounts=await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json());
 const staged=await stageCanonical(page,"recovery "+Date.now());
 let fail=true;let confirmations=0;let duplicate:Promise<number>|undefined;
 await page.route("**/statements/wise/confirm",async route=>{
  const request=route.request();confirmations++;
  if(fail){fail=false;return route.continue({postData:JSON.stringify({previews:[...request.postDataJSON().previews,{preview_id:"00000000-0000-4000-8000-000000000099"}]})});}
  if(!duplicate){
   // Real duplicate HTTP command against the real API, not a fulfilled mock.
   duplicate=page.evaluate(async({body,headers})=>(await fetch("/api/v1/statements/wise/confirm",{method:"POST",headers,body})).status,
    {body:request.postData()!,headers:Object.fromEntries(Object.entries(request.headers()).filter(([key])=>["content-type","x-csrf-token","x-moneylens-session-id"].includes(key)))});
  }
  await route.continue();
 });
 let pending=page.waitForResponse(r=>r.url().endsWith("/statements/wise/confirm"));
 await page.getByRole("button",{name:"Confirm imports",exact:true}).click();expect((await pending).status()).toBe(404);
 await expect(page.locator("main").getByRole("alert")).toContainText("Nothing in this batch was imported");
 expect(await ledger(page)).toEqual(before);expect(await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json())).toEqual(beforeAccounts);
 pending=page.waitForResponse(r=>r.url().endsWith("/statements/wise/confirm")&&r.status()===200);
 await page.getByRole("button",{name:"Confirm imports",exact:true}).evaluate(button=>{(button as HTMLButtonElement).click();(button as HTMLButtonElement).click();});
 const saved=await(await pending).json();expect(saved.added_count).toBe(2);expect(await duplicate).toBe(200);
 await expect(page.getByRole("link",{name:"View transactions",exact:true})).toBeVisible();
 const account=saved.files[0].account_id,oldLink=`/transactions?account_id=${account}&start=2026-10-01&end=2026-11-01`;
 const owned=await ledger(page),added=owned.filter(r=>!before.some(old=>old.id===r.id));expect(owned).toHaveLength(before.length+2);expect(added.reduce((n,r)=>n+r.amount_minor,0)).toBe(-1000);expect(new Set(added.map(r=>r.id)).size).toBe(2);
 await page.getByRole("link",{name:"View transactions",exact:true}).click();await expect(page.locator("[data-ledger-row]")).toHaveCount(2);await page.reload();await expect(page.locator("[data-ledger-row]")).toHaveCount(2);
 await submitRecords(page,owned.length);await expect(page.locator("[data-coach-ledger-row]").first()).toContainText("recovery");
 // Stage an unpublished preview before logout, then try it under the other owner.
 const privatePreview=await stageCanonical(page,"unpublished");
 await page.goto("/settings");await page.getByRole("button",{name:"Sign out",exact:true}).click();await expect(page.getByRole("link",{name:"Connect your bank",exact:true})).toBeVisible();
 await page.goBack();await expect(page.locator("[data-statement-file]")).toHaveCount(0);await expect(page.locator("[data-ledger-row]")).toHaveCount(0);await expect(page.locator("[data-coach-ledger-row]")).toHaveCount(0);
 const second=await signin(page,"other-owner");expect(second.owner).not.toEqual(first.owner);
 await page.goBack();await page.reload();await expect(page.locator("body")).not.toContainText("Synthetic recovery");
 // Back can land on the offline issuer rather than an application document.
 await page.goto("/coach");await expect(page.locator("main")).not.toContainText("Synthetic recovery");
 const denied=await page.evaluate(async({account,preview})=>{
  const s=await(await fetch("/api/v1/auth/session")).json();
  const headers={"Content-Type":"application/json","X-CSRF-Token":s.csrf_token,"X-MoneyLens-Session-ID":s.session_id};
  return Promise.all([
   fetch("/api/v1/ledger/transactions?"+new URLSearchParams({start:"2026-10-01",end_exclusive:"2026-11-01",account_id:account})),
   fetch("/api/v1/statements/wise/confirm",{method:"POST",headers,body:JSON.stringify({previews:[{preview_id:preview,new_account_label:"Cannot steal"}]})}),
   fetch("/api/v1/coach/query",{method:"POST",headers,body:JSON.stringify({question:"Show transactions from 2026-10-01 until 2026-11-01",card_locale:"en",privacy:true,currency:"EUR",account_ids:[account],expected_data_version:null,conversation_context:null})})
  ]).then(replies=>replies.map(r=>r.status));
 },{account,preview:privatePreview.id});expect(denied).toEqual([404,404,404]);
 await page.goto(oldLink);await expect(page.locator("[data-ledger-row]")).toHaveCount(0);await expect(page.locator("main")).not.toContainText("Synthetic recovery");
 const otherRows=await ledger(page);expect(otherRows.every(r=>!owned.some(old=>old.id===r.id))).toBe(true);
 await submitRecords(page,otherRows.length);await expect(page.locator("main")).not.toContainText("Synthetic recovery");
 await signin(page,"release-recovery");expect(await ledger(page)).toHaveLength(before.length+2);
 await info.attach("recovery.json",{body:JSON.stringify({failedNoPartial:true,retryRows:2,sameDateAndAmountPreserved:true,concurrentConfirmStatus:200,confirmationRequests:confirmations,foreignStatuses:denied,accountSwitch:"same tab, back, reload and old link passed",unusedStagedPreview:staged.state}),contentType:"application/json"});
});
