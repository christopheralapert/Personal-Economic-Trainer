import {test,expect} from "@playwright/test";
import {ledger,signin,stageCanonical,submitRecords} from "./release-support";

test("anonymous Finnish organizer answer and opened transaction",async({page},info)=>{
 await page.addInitScript(()=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:"fi",savings:10})));
 await page.goto("/demo?dataset=organizer1&tab=coach");
 await page.getByRole("textbox",{name:"Kysymyksesi",exact:true}).fill("Paljonko käytin takseihin viime kuussa?");
 const pending=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/chat");await page.getByRole("button",{name:"Lähetä kysymys",exact:true}).click();
 const response=await pending;expect(response.headers()["x-money-coach-source"]).toBe("rule");
 const answer=page.locator('[data-message-role="assistant"]').first();await expect(answer.locator("[data-spoken-answer]")).toHaveText("Käytit takseihin elokuussa 2026 yhteensä 30,97 €.");
 await answer.locator("li button").first().click();await expect(page.getByRole("dialog")).toContainText("MRC-TRN-0063");await expect(page.getByRole("dialog")).toContainText("30,97");
 await page.screenshot({path:info.outputPath("finnish-evidence.png"),animations:"disabled"});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect((await page.context().cookies()).some(c=>c.name.includes("moneylens_session"))).toBe(false);
});
test("fresh normal test-signup entry, canonical import, reloaded History and private Coach",async({page},info)=>{
 const subject="release-"+info.project.name;await signin(page,subject);expect(await ledger(page)).toEqual([]);
 await stageCanonical(page,info.project.name);const pending=page.waitForResponse(r=>r.url().endsWith("/statements/wise/confirm")),start=performance.now();
 await page.getByRole("button",{name:"Confirm imports",exact:true}).click();const saved=await(await pending).json();expect(saved.added_count).toBe(2);
 await page.getByRole("link",{name:"View transactions",exact:true}).click();await expect(page.locator("[data-ledger-row]")).toHaveCount(2);const confirmationToHistoryMs=Math.round(performance.now()-start);
 await page.reload();await expect(page.locator("[data-ledger-row]")).toHaveCount(2);expect((await ledger(page)).reduce((n,r)=>n+r.amount_minor,0)).toBe(-1000);
 await submitRecords(page,2);await page.locator("[data-coach-ledger-row]").first().getByRole("button").click();await expect(page.getByRole("dialog")).toContainText("Synthetic "+info.project.name);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 console.log(JSON.stringify({project:info.project.name,confirmationToHistoryMs,transport:"local rules; real API/PostgreSQL; signed test OIDC"}));
});
