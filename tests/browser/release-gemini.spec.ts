import {test,expect} from "@playwright/test";
import {ledger,signin} from "./release-support";

test.skip(process.env.MONEYLENS_RELEASE_LIVE_GEMINI!=="true","One explicitly opted-in paid synthetic request; run signup-statements first on the same fresh rehearsal.");
test("real private gemini-3.5-flash uses the imported ledger and opens matching evidence",async({page},info)=>{
 await signin(page,"model-review");const saved=await ledger(page);expect(saved).toHaveLength(3);
 const minor=-saved.reduce((n,r)=>n+r.amount_minor,0);expect(minor).toBe(3797);
 await page.goto("/coach");await page.getByRole("combobox",{name:"Answer card language",exact:true}).selectOption("fi");
 await page.getByRole("checkbox",{name:"Yksityisyystila",exact:true}).uncheck();
 await page.locator("#coach-question").fill("Paljonko käytin takseihin lokakuussa 2026?");
 const pending=page.waitForResponse(r=>r.url().endsWith("/coach/query")),start=performance.now();await page.getByRole("button",{name:"Lue tapahtumani",exact:true}).click();
 const response=await pending,body=await response.json();
 console.log(JSON.stringify({status:response.status(),source:body.source,provider:body.provider,diagnostic:body.model_diagnostic}));
 expect(response.status()).toBe(200);expect(body.source).toBe("model");expect(body.provider).toBe("gemini-direct");expect(body.model_diagnostic).toBeNull();expect(body.card.answer.artifact.result.net_minor).toBe(minor);
 const answer=page.locator("[data-coach-answer]").last();await expect(answer).toContainText("37,97");await expect(answer).toContainText("2026-10-01");await expect(answer).toContainText("2026-10-31");const questionToAnswerMs=Math.round(performance.now()-start);
 const evidence=page.waitForResponse(r=>r.url().includes("/ledger/transactions?"));await page.getByRole("button",{name:"Alustapahtumat",exact:true}).click();const rows=(await(await evidence).json()).rows;expect(rows).toHaveLength(3);expect(rows.reduce((n:number,r:{amount_minor:number})=>n+r.amount_minor,0)).toBe(-minor);
 await page.locator("[data-coach-evidence-row]").first().getByRole("button").click();await expect(page.getByRole("dialog",{name:"Tapahtuman tiedot",exact:true})).toContainText("Synthetic taxi");
 await page.screenshot({path:info.outputPath("real-gemini-evidence.png"),animations:"disabled"});
 const result={source:body.source,provider:body.provider,model:"gemini-3.5-flash",netMinor:minor,questionToAnswerMs,serverTiming:response.headers()["server-timing"],sentence:body.answer_text,transactionOpened:true,build:response.headers()["x-moneylens-build"]};
 await info.attach("real-private-gemini.json",{body:JSON.stringify(result),contentType:"application/json"});console.log(JSON.stringify(result));
});
