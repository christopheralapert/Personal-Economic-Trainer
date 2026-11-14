import {test,expect} from "@playwright/test";
import {ledger,signin} from "./release-support";

test("saved History, Overview and local Coach agree for A, B and both accounts",async({page})=>{
 await signin(page,"model-review");
 const accounts=await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json());expect(accounts).toHaveLength(2);
 const a=accounts.find((account:{name:string})=>account.name==="Synthetic taxi A account").id;
 const b=accounts.find((account:{name:string})=>account.name==="Synthetic taxi B account").id;
 for(const [account,minor,count]of [[a,3097,2],[b,700,1],["",3797,3]] as [string,number,number][]){
  const rows=await ledger(page,account);expect(rows).toHaveLength(count);expect(rows.reduce((n,r)=>n+r.amount_minor,0)).toBe(-minor);
  await page.goto("/");await expect(page.getByRole("combobox",{name:"Accounts",exact:true})).toBeVisible();
  if(account)await page.getByRole("combobox",{name:"Accounts",exact:true}).selectOption(account);
  await expect(page.locator('[data-overview-block="period"]')).toContainText("October 2026");
  await expect(page.locator('[data-overview-block="hero"]')).toContainText((minor/100).toFixed(2).replace(".",","));
  await page.getByRole("button",{name:/^Taxis /}).click();await expect(page.getByRole("dialog").locator("li")).toHaveCount(count);
  await page.getByRole("dialog").getByRole("button",{name:"Done",exact:true}).click();
  await page.goto("/transactions?"+new URLSearchParams({start:"2026-10-01",end:"2026-11-01",...(account?{account_id:account}:{})}));await expect(page.locator("[data-ledger-row]")).toHaveCount(count);
  const url=new URL(page.url());expect(url.searchParams.get("start")).toBe("2026-10-01");expect(url.searchParams.get("end")).toBe("2026-11-01");expect(url.searchParams.get("account_id")??"").toBe(account);
  await page.goto("/coach");await page.getByRole("combobox",{name:"Account scope",exact:true}).selectOption(account);await page.locator("#coach-question").fill("How much did I spend on taxis in October 2026?");
  const pending=page.waitForResponse(r=>r.url().endsWith("/coach/query"));await page.getByRole("button",{name:"Read my records",exact:true}).click();
  const answer=await(await pending).json();expect(answer.source).toBe("rule");expect(answer.provider).toBeNull();expect(answer.model_usage?.calls??0).toBe(0);expect(answer.card.answer.artifact.result.net_minor).toBe(minor);
  await expect(page.locator("[data-coach-answer]").last()).toContainText((minor/100).toFixed(2));
 }
});
