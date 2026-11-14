import {test,expect} from "@playwright/test";
import {signin,ledger} from "./release-support";
import {coachCopy} from "../../frontend/web/i18n/private-coach";
import {en,fi,et} from "../../frontend/coach/src/i18n/dictionaries";

const api=process.env.MONEYLENS_GUARD_API!;
const control={headers:{"X-MoneyLens-Rehearsal":"synthetic-amount-guard"}};
const cases=[
 {locale:"et",limited:"Näita eelmise kuu üle 20 € taksosõite",normal:"Kui palju kulutasin taksodele eelmisel kuul?",message:"Summapiiranguga otsingut veel ei toetata"},
 {locale:"en",limited:"Show last month's taxi rides over EUR 20.",normal:"How much did I spend on taxis last month?",message:"Amount filters are not supported"},
 {locale:"fi",limited:"Näytä viime kuun yli 20 euron taksimatkat.",normal:"Paljonko käytin takseihin viime kuussa?",message:"Summarajauksia ei vielä tueta"},
] as const;

test("ET/EN/FI unsupported limits stay local; native Gemini test transport and local taxi evidence still work",async({page,request})=>{
 await signin(page,"model-review");
 const accounts=await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json());
 const account=accounts.find((r:{name:string})=>r.name==="Synthetic taxi A account").id,saved=await ledger(page,account);
 expect(saved.length).toBe(2);expect(saved.reduce((sum,r)=>sum+r.amount_minor,0)).toBe(-3097);
 await page.goto("/coach");
 for(const sample of cases){
  const c=coachCopy[sample.locale],copy={en,fi,et}[sample.locale];
  await page.getByRole("combobox").first().selectOption(sample.locale);
  await page.getByRole("combobox",{name:c.account,exact:true}).selectOption(account);
  await page.getByRole("checkbox",{name:c.privacy,exact:true}).uncheck();
  async function submit(question:string){
   await page.locator("#coach-question").fill(question);const pending=page.waitForResponse(r=>r.url().endsWith("/coach/query"));
   await page.getByRole("button",{name:c.ask,exact:true}).click();const response=await pending;expect(response.status()).toBe(200);return response.json();
  }
  async function limited(){
   const before=await(await request.get(api+"/rehearsal/counts",control)).json(),body=await submit(sample.limited);
   expect(body.source).toBe("rule");expect(body.provider).toBeNull();expect(body.model_usage).toBeNull();
   expect(body.transactions).toBeNull();expect(body.card).toBeNull();expect(body.habits).toBeNull();
   expect(body.interpretation.status).toBe("clarification_required");expect(body.answer_text.split("?")).toHaveLength(2);
   const turn=page.locator("[data-coach-turn]").last();await expect(turn).toContainText(sample.message);await expect(turn.locator("[data-coach-ledger-row]")).toHaveCount(0);
   expect(await(await request.get(api+"/rehearsal/counts",control)).json()).toEqual(before);
  }
  await limited();
  await page.waitForTimeout(5350); // Preserve the existing per-user model admission interval.
  const before=await(await request.get(api+"/rehearsal/counts",control)).json();const body=await submit(sample.normal);
  expect(body.source).toBe("model");expect(body.provider).toBe("gemini-direct");expect(body.model_usage.calls).toBe(1);
  const result=body.card.answer.artifact.result;
  expect(result.net_minor).toBe(3097);expect(result.scope.account_ids.length===1&&result.scope.account_ids[0]===account).toBe(true);
  expect(result.scope.start).toBe("2026-10-01");expect(result.scope.end_exclusive).toBe("2026-11-01");
  const answer=page.locator("[data-coach-answer]").last();await expect(answer).toContainText(sample.locale==="en"?"30.97":"30,97");
  await expect(answer).toContainText("2026-10-01");await expect(answer).toContainText("2026-10-31");
  const pending=page.waitForResponse(r=>r.url().includes("/ledger/transactions?"));await page.getByRole("button",{name:c.records,exact:true}).last().click();
  const evidence=await(await pending).json();expect(evidence.rows.length).toBe(2);
  expect(JSON.stringify(evidence.rows.map((r:{id:string})=>r.id).sort())===JSON.stringify(saved.map(r=>r.id).sort())).toBe(true);
  await page.locator("[data-coach-evidence-row]").first().getByRole("button").click();
  const detail=page.getByRole("dialog",{name:c.details,exact:true});await expect(detail).toContainText("Synthetic taxi");
  await detail.getByRole("button",{name:copy.done,exact:true}).click();
  await page.getByRole("dialog",{name:c.records,exact:true}).getByRole("button",{name:copy.done,exact:true}).click();
  const after=await(await request.get(api+"/rehearsal/counts",control)).json();expect(after.gemini-before.gemini).toBe(1);expect(after.verda).toBe(0);
  await limited(); // Immediate post-model request must not get a model cooldown rejection.
  await page.getByRole("checkbox",{name:c.privacy,exact:true}).check();const local=await submit(sample.normal);
  expect(local.source).toBe("rule");expect(local.provider).toBeNull();expect(local.card.answer.artifact.result.net_minor).toBe(3097);
  expect(await(await request.get(api+"/rehearsal/counts",control)).json()).toEqual(after);
 }
});

test("fresh anonymous browser opens organizer1 and Learn without sign-in, with Finnish taxi evidence",async({page})=>{
 await page.addInitScript(()=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:"fi",savings:10})));
 await page.goto("/demo?dataset=organizer1&tab=coach");
 await page.getByRole("textbox",{name:fi.questionLabel,exact:true}).fill("Paljonko käytin takseihin viime kuussa?");
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/chat");await page.getByRole("button",{name:fi.send,exact:true}).click();
 const response=await pending;expect(response.headers()["x-money-coach-source"]).toBe("rule");
 const answer=page.locator('[data-message-role="assistant"]').last();await expect(answer.locator("[data-spoken-answer]")).toHaveText("Käytit takseihin elokuussa 2026 yhteensä 30,97 €.");
 await answer.locator("li button").first().click();await expect(page.getByRole("dialog")).toContainText("MRC-TRN-0063");
 await page.getByRole("dialog").getByRole("button",{name:fi.done,exact:true}).click();
 await page.goto("/demo?dataset=organizer1&tab=learn");await expect(page.getByRole("tab",{name:fi.learn,exact:true})).toHaveAttribute("aria-selected","true");
 for(const name of[fi.regularShort,fi.surprisesShort,fi.everydayShort,fi.fund,fi.savingConcept,fi.habit])await expect(page.getByRole("button",{name:new RegExp(`^${name} `)})).toBeVisible();
 expect((await page.context().cookies()).some(cookie=>cookie.name.includes("moneylens_session"))).toBe(false);
});

test("fresh browser can sign into the empty identity and repeat login without sample-data leakage",async({page})=>{
 const first=await signin(page,"fresh-preview");
 expect(await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json())).toEqual([]);expect(await ledger(page)).toEqual([]);
 await page.goto("/coach");await expect(page.locator("#coach-question")).toBeEditable();await expect(page.locator("[data-coach-answer],[data-coach-ledger-row]")).toHaveCount(0);
 const again=await signin(page,"fresh-preview");expect(JSON.stringify(first.owner)===JSON.stringify(again.owner)).toBe(true);
 expect(await page.evaluate(async()=>await(await fetch("/api/v1/accounts")).json())).toEqual([]);
});
