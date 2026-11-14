import {test,expect,type Page,type BrowserContext} from "@playwright/test";
import path from "node:path";
const fixtures=process.env.MONEYLENS_SIGNUP_STATEMENT_FIXTURES;
const live=process.env.MONEYLENS_SIGNUP_LIVE_GEMINI==="true";
test.skip(!fixtures,"Requires generated synthetic fixtures and a fresh isolated signup server; never run against a real identity provider.");
const file=(page:Page,name:string)=>page.locator(`[data-statement-file="${name}"]`);
async function signIn(page:Page,subject:string){
 await page.goto("/banks");await page.getByRole("link",{name:"Sign in with your identity provider",exact:true}).click();
 await expect(page.getByRole("heading",{name:"Isolated synthetic identity",exact:true})).toBeVisible();
 await page.getByRole("link",{name:subject,exact:true}).click();await expect(page.getByRole("link",{name:"Learn",exact:true})).toBeVisible();
 const session=await page.evaluate(async()=>{const r=await fetch("/api/v1/auth/session");if(!r.ok)throw Error("Session unavailable");return r.json();});
 expect(session.synthetic).toBe(false);return session;
}
async function rows(page:Page,account=""){
 return page.evaluate(async account=>{const q=new URLSearchParams({start:"2026-10-01",end_exclusive:"2026-11-01"});if(account)q.set("account_id",account);const r=await fetch("/api/v1/ledger/transactions?"+q);if(!r.ok)throw Error("Owned ledger unavailable");return(await r.json()).rows;},account);
}
async function choose(page:Page,names:string[]){await page.goto("/banks");const chooser=page.waitForEvent("filechooser");await page.getByLabel("Choose statements",{exact:true}).click();await(await chooser).setFiles(names.map(name=>path.join(fixtures!,name)));await page.getByRole("button",{name:"Preview statements",exact:true}).click();for(const name of names)await expect(file(page,name).getByText(/Statement period:/)).toBeVisible();}
async function newAccount(page:Page,name:string,label:string){await file(page,name).getByLabel("Account",{exact:true}).selectOption("new");await file(page,name).getByLabel("New account name",{exact:true}).fill(label);}
async function confirm(page:Page){const pending=page.waitForResponse(r=>r.url().endsWith("/statements/wise/confirm")&&r.request().method()==="POST");await page.getByRole("button",{name:"Confirm imports",exact:true}).click();const response=await pending;expect(response.status()).toBe(200);return response.json();}
async function reviewTaxis(page:Page,count:number){
 await page.goto("/transactions?start=2026-10-01&end=2026-11-01");await expect(page.locator("[data-ledger-row]")).toHaveCount(count);
 for(let i=0;i<count;i++){
  await page.locator("[data-ledger-row]").nth(i).getByRole("button").click();const dialog=page.getByRole("dialog",{name:"Review classification",exact:true});
  await dialog.getByRole("radio",{name:"Expense",exact:true}).check();await dialog.getByLabel("Category",{exact:true}).selectOption("taxi");await dialog.getByLabel("Spending basket",{exact:true}).selectOption("everyday");
  const pending=page.waitForResponse(r=>r.url().endsWith("/classification")),reload=page.waitForResponse(r=>r.url().includes("/ledger/transactions?"));await dialog.getByRole("button",{name:"Save classification",exact:true}).click();expect((await pending).status()).toBe(200);await reload;await expect(dialog).toHaveCount(0);
 }
}
async function emptyCoach(page:Page){await page.goto("/coach");await page.locator("#coach-question").fill("Show transactions from 2026-10-01 until 2026-11-01");const response=page.waitForResponse(r=>r.url().endsWith("/coach/query"));await page.getByRole("button",{name:"Read my records",exact:true}).click();const r=await response;expect(r.status()).toBe(200);expect((await r.json()).transactions.rows).toEqual([]);await expect(page.locator("[data-coach-ledger-row]")).toHaveCount(0);}

test("two fresh OIDC members: automatic workspaces, persisted imports, account totals, evidence and isolation",async({browser},info)=>{
 const contexts:BrowserContext[]=[];const output:Record<string,unknown>={identity:"signed offline test OIDC; no Auth0",liveGemini:live};
 try{
  const a=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:"block",reducedMotion:"reduce"}),b=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:"block",reducedMotion:"reduce"});contexts.push(a,b);
  const page=await a.newPage(),other=await b.newPage(),errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));other.on("pageerror",e=>errors.push(e.message));
  const first=await signIn(page,"model-review"),second=await signIn(other,"other-owner");
  expect(first.owner.tenant_id).not.toBe(second.owner.tenant_id);expect(first.owner.user_id).not.toBe(second.owner.user_id);
  for(const p of [page,other]){expect(await p.evaluate(async()=>await(await fetch("/api/v1/accounts")).json())).toEqual([]);expect(await rows(p)).toEqual([]);}
  const names=["synthetic-taxis-a.csv","synthetic-taxis-b.xml"];await choose(page,names);await newAccount(page,names[0],"Synthetic taxi A account");await newAccount(page,names[1],"Synthetic taxi B account");
  const tick=performance.now(),saved=await confirm(page);expect(saved.added_count).toBe(3);const [accountA,accountB]=saved.files.map((f:{account_id:string})=>f.account_id);expect(accountA).not.toBe(accountB);
  await file(page,names[0]).getByRole("link",{name:"View transactions",exact:true}).click();await expect(page.locator("[data-ledger-row]")).toHaveCount(2);output.confirmationToHistoryMs=Math.round(performance.now()-tick);
  expect((await rows(page,accountA)).reduce((n:number,r:{amount_minor:number})=>n+r.amount_minor,0)).toBe(-3097);expect((await rows(page,accountB)).reduce((n:number,r:{amount_minor:number})=>n+r.amount_minor,0)).toBe(-700);
  await reviewTaxis(page,3);await page.reload();await expect(page.locator("[data-ledger-row]")).toHaveCount(3);
  await choose(page,["synthetic-overlap-a.csv"]);await file(page,"synthetic-overlap-a.csv").getByLabel("Account",{exact:true}).selectOption(accountA);
  const overlap=page.waitForResponse(r=>r.url().endsWith("/statements/wise/confirm"));await page.getByRole("button",{name:"Confirm imports",exact:true}).click();expect((await overlap).status()).toBe(409);
  await expect(page.locator("main").getByRole("alert")).toContainText("Possible overlap");expect(await rows(page)).toHaveLength(3);await page.getByRole("button",{name:"Remove synthetic-overlap-a.csv",exact:true}).click();output.partialOverlap="blocked; removing file preserves saved rows";
  await choose(page,[names[0]]);await file(page,names[0]).getByLabel("Account",{exact:true}).selectOption(accountA);expect((await confirm(page)).added_count).toBe(0);
  await file(page,names[0]).getByRole("link",{name:"Ask Coach",exact:true}).click();await page.getByRole("combobox",{name:"Answer card language",exact:true}).selectOption("fi");
  const results:unknown[]=[];
  for(const model of live?[false,true]:[false]){
   const privacy=page.getByRole("checkbox",{name:"Yksityisyystila",exact:true});if(model)await privacy.uncheck();else await expect(privacy).toBeChecked();
   for(const [i,scope] of [{account:accountA,minor:3097,count:2},{account:accountB,minor:700,count:1},{account:"",minor:3797,count:3}].entries()){
    if(model&&i>0)await page.waitForTimeout(5300); // Existing admission cooldown, outside measured question time.
    await page.getByRole("combobox",{name:"Tilien rajaus",exact:true}).selectOption(scope.account);
    await page.locator("#coach-question").fill("Paljonko käytin takseihin lokakuussa 2026?");const pending=page.waitForResponse(r=>r.url().endsWith("/coach/query")),start=performance.now();await page.getByRole("button",{name:"Lue tapahtumani",exact:true}).click();const response=await pending,body=await response.json();
    console.log(JSON.stringify({scope:i,requestedModel:model,status:response.status(),source:body.source,provider:body.provider,diagnostic:body.model_diagnostic}));
    expect(response.status()).toBe(200);expect(body.source).toBe(model?"model":"rule");expect(body.provider).toBe(model?"gemini-direct":null);expect(body.card.answer.artifact.result.net_minor).toBe(scope.minor);
    const answer=page.locator("[data-coach-answer]").last();await expect(answer).toContainText((scope.minor/100).toFixed(2).replace(".",","));await expect(answer).toContainText("2026-10-01");await expect(answer).toContainText("2026-10-31");const elapsed=Math.round(performance.now()-start);
    const pendingEvidence=page.waitForResponse(r=>r.url().includes("/ledger/transactions?"));await page.getByRole("button",{name:"Alustapahtumat",exact:true}).click();const evidence=await(await pendingEvidence).json();expect(evidence.rows).toHaveLength(scope.count);expect(evidence.rows.reduce((n:number,r:{amount_minor:number})=>n+r.amount_minor,0)).toBe(-scope.minor);
    await page.locator("[data-coach-evidence-row]").first().getByRole("button").click();const detail=page.getByRole("dialog",{name:"Tapahtuman tiedot",exact:true});await expect(detail).toContainText("Synthetic taxi");await page.screenshot({path:info.outputPath(`${model?"gemini":"local"}-${i}-evidence.png`),animations:"disabled"});await detail.getByRole("button",{name:"Valmis",exact:true}).click();await expect(detail).toHaveCount(0);const sheet=page.getByRole("dialog",{name:"Alustapahtumat",exact:true});await sheet.getByRole("button",{name:"Valmis",exact:true}).click();await expect(sheet).toHaveCount(0);
    results.push({scope:i,source:body.source,provider:body.provider,netMinor:scope.minor,evidenceCount:scope.count,transactionOpened:true,questionToAnswerMs:elapsed,serverTiming:response.headers()["server-timing"],sentence:body.answer_text});
   }
  }
  await emptyCoach(other);
  const foreign=await other.evaluate(async account=>(await fetch("/api/v1/ledger/transactions?"+new URLSearchParams({start:"2026-10-01",end_exclusive:"2026-11-01",account_id:account}))).status,accountA);expect(foreign).toBe(404);
  const stolen=await other.evaluate(async preview_id=>{const session=await(await fetch("/api/v1/auth/session")).json();return(await fetch("/api/v1/statements/wise/confirm",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},body:JSON.stringify({previews:[{preview_id}]})})).status;},saved.files[0].id);expect(stolen).toBe(404);
  await choose(other,[names[0]]);await newAccount(other,names[0],"Second member's synthetic account");expect((await confirm(other)).added_count).toBe(2);expect((await rows(other)).reduce((n:number,r:{amount_minor:number})=>n+r.amount_minor,0)).toBe(-3097);expect(await rows(page)).toHaveLength(3);
  await other.goto("/coach");await other.locator("#coach-question").fill("Show transactions from 2026-10-01 until 2026-11-01");const secondAnswer=other.waitForResponse(r=>r.url().endsWith("/coach/query"));await other.getByRole("button",{name:"Read my records",exact:true}).click();expect((await(await secondAnswer).json()).transactions.rows).toHaveLength(2);await expect(other.locator("[data-coach-ledger-row]")).toHaveCount(2);
  await page.goto("/api/v1/auth/login");await page.getByRole("link",{name:"model-review",exact:true}).click();const again=await page.evaluate(async()=>await(await fetch("/api/v1/auth/session")).json());expect(again.owner).toEqual(first.owner);expect(again.session_id).not.toBe(first.session_id);expect(await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json())).toHaveLength(2);
  for(const p of [page,other])expect(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
  output.answers=results;output.freshWorkspaces=2;output.repeatAdded=0;output.ownerIsolation="passed";output.repeatLogin="same workspace";output.build=(await page.request.get("/banks")).headers()["x-moneylens-build"];
  await info.attach("signup-two-owners.json",{body:JSON.stringify(output,null,2),contentType:"application/json"});console.log(JSON.stringify(output));
 }finally{await Promise.all(contexts.map(context=>context.close()));}
});
