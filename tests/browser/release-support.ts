import {expect,type Page} from "@playwright/test";

export const period={start:"2026-10-01",end_exclusive:"2026-11-01"};
export async function signin(page:Page,subject:string){
 await page.goto("/banks");
 const entry=page.getByRole("link",{name:"Connect your bank",exact:true});
 if(await entry.isVisible())await entry.click();else await page.goto("/api/v1/auth/login");
 await expect(page.getByRole("heading",{name:"Isolated synthetic identity",exact:true})).toBeVisible();
 await page.getByRole("link",{name:subject,exact:true}).click();
 await expect(page.getByRole("link",{name:"Learn",exact:true})).toBeVisible();
 const session=await page.evaluate(async()=>await(await fetch("/api/v1/auth/session")).json());
 expect(session.synthetic).toBe(false);return session;
}
export async function ledger(page:Page,account?:string){
 return page.evaluate(async({period,account})=>{
  const query=new URLSearchParams(period);if(account)query.set("account_id",account);
  const response=await fetch("/api/v1/ledger/transactions?"+query);if(!response.ok)throw Error("Owned ledger unavailable");
  return(await response.json()).rows as {id:string;amount_minor:number;merchant:string}[];
 },{period,account});
}
export function canonical(label:string){return "reference,booked_on,amount_minor,currency,description\n"+
 `same,2026-10-03,-500,EUR,Synthetic ${label} purchase one\n`+
 `same,2026-10-03,-500,EUR,Synthetic ${label} purchase two\n`;}
export async function stageCanonical(page:Page,label:string){
 await page.goto("/banks");const chooser=page.waitForEvent("filechooser");await page.getByLabel("Choose statements",{exact:true}).click();
 await(await chooser).setFiles({name:"synthetic-canonical.csv",mimeType:"text/csv",buffer:Buffer.from(canonical(label))});
 const response=page.waitForResponse(r=>r.url().endsWith("/statements/wise/preview"));
 await page.getByRole("button",{name:"Preview statements",exact:true}).click();const data=await(await response).json();
 expect(data).toMatchObject({state:"preview",currency:"EUR",count:2,start:"2026-10-03",end_exclusive:"2026-10-04"});
 const item=page.locator('[data-statement-file="synthetic-canonical.csv"]');
 await expect(item).toContainText("EUR · 2 entries");await expect(item).toContainText("2026-10-03");
 await item.getByLabel("Account",{exact:true}).selectOption("new");await item.getByLabel("New account name",{exact:true}).fill("Synthetic "+label);
 return data;
}
export async function submitRecords(page:Page,count:number){
 await page.goto("/coach");await page.locator("#coach-question").fill("Show transactions from 2026-10-01 until 2026-11-01");
 const pending=page.waitForResponse(r=>r.url().endsWith("/coach/query"));await page.getByRole("button",{name:"Read my records",exact:true}).click();
 const response=await pending;expect(response.status()).toBe(200);const answer=await response.json();
 expect(answer.source).toBe("rule");expect(answer.transactions.rows).toHaveLength(count);await expect(page.locator("[data-coach-ledger-row]")).toHaveCount(count);return answer;
}
