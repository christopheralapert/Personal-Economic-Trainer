import {test,expect,type Page} from "@playwright/test";

const cases=[
 {locale:"en",question:"How much did I spend on taxis last month?",label:"Your question",send:"Send question",sentence:"Recorded net spending on Taxis: 30,97 €. Period: August 2026.",followup:"What about the month before?",detail:"Transaction details",done:"Done"},
 {locale:"et",question:"Kui palju kulutasin eelmisel kuul taksole?",label:"Sinu küsimus",send:"Saada küsimus",sentence:"Kirjendatud netokulu (Takso): 30,97 €. Periood: august 2026.",followup:"Aga juulis 2026?",detail:"Tehingu üksikasjad",done:"Valmis"},
 {locale:"fi",question:"Paljonko käytin takseihin viime kuussa?",label:"Kysymyksesi",send:"Lähetä kysymys",sentence:"Käytit takseihin elokuussa 2026 yhteensä 30,97 €.",followup:"Entä heinäkuussa 2026?",detail:"Tapahtuman tiedot",done:"Valmis"},
] as const;
const answers=(page:Page)=>page.locator('[data-message-role="assistant"]');

for(const sample of cases) test(`main demo Coach: ${sample.locale} sentence, context and transaction evidence`,async({page},testInfo)=>{
 if(sample.locale==="fi")await page.setViewportSize({width:390,height:844});
 await page.addInitScript(locale=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:10})),sample.locale);
 await page.goto("/demo?dataset=organizer1&tab=coach");
 const input=page.getByRole("textbox",{name:sample.label,exact:true});
 await expect(input).toBeVisible();
 async function ask(question:string){
  await input.fill(question);
  const pending=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/chat");
  await page.getByRole("button",{name:sample.send,exact:true}).click();
  const response=await pending;expect(response.status()).toBe(200);
  expect(response.headers()["x-money-coach-source"]).toBe("rule");
  expect(response.headers()["x-money-coach-evaluation"]).toBe("privacy_rule");
  await expect(input).toBeEnabled();return response;
 }
 const response=await ask(sample.question);
 expect(response.request().postDataJSON()).toMatchObject({dataset:"organizer1",locale:sample.locale,privacy:true});
 const first=answers(page).first();
 await expect(first.locator("[data-spoken-answer]")).toHaveText(sample.sentence);
 await expect(first.locator("[data-spoken-answer]")).toBeVisible();
 await page.screenshot({path:testInfo.outputPath("taxi-answer.png"),fullPage:true,animations:"disabled"});
 // Open the actual transaction row, rather than the period/source drawer.
 const row=first.locator("li").first(),merchant=await row.getByRole("button").first().innerText();
 const amount=await row.locator("span").last().innerText();
 await row.getByRole("button",{name:merchant,exact:true}).click();
 const detail=page.getByRole("dialog");
 await expect(detail.getByRole("heading",{name:sample.detail,exact:true})).toBeVisible();
 await expect(detail).toContainText(merchant);await expect(detail).toContainText(amount);
 await detail.getByRole("button",{name:sample.done,exact:true}).click();
 await expect(detail).toHaveCount(0);
 const followup=await ask(sample.followup),payload=followup.request().postDataJSON();
 expect(payload.messages).toEqual([{role:"user",parts:[{type:"text",text:sample.followup}]}]);
 expect(payload.context).toEqual({tool:"showTransactions",input:{period:{start:"2026-08-01",end:"2026-09-01"},category:"taxi"}});
 const stream=await followup.text();
 expect(stream).toContain('"start":"2026-07-01","end":"2026-08-01"');expect(stream).toContain('"category":"taxi"');
 await expect(answers(page)).toHaveCount(2);
 await expect(first.locator("[data-spoken-answer]")).toHaveText(sample.sentence);
 await page.reload();await expect(answers(page)).toHaveCount(2);
 await expect(answers(page).first().locator("[data-spoken-answer]")).toHaveText(sample.sentence);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test("Finnish merchant answer exposes intersecting scope and retains it in a follow-up",async({page})=>{
 await page.addInitScript(()=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:"fi",savings:10})));
 await page.goto("/demo?dataset=organizer1&tab=coach");
 const input=page.getByRole("textbox",{name:"Kysymyksesi",exact:true});
 async function ask(question:string){
  await input.fill(question);const pending=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/chat");
  await page.getByRole("button",{name:"Lähetä kysymys",exact:true}).click();
  const response=await pending;expect(response.status()).toBe(200);await expect(input).toBeEnabled();return response;
 }
 await ask('Paljonko käytin takseihin paikassa "MRC-TRN-0063" viime kuussa?');
 const first=answers(page).first();
 await expect(first.locator("dl")).toContainText("Taksit");await expect(first.locator("dl")).toContainText("MRC-TRN-0063");
 await expect(first.locator("[data-spoken-answer]")).toHaveText("Käytit takseihin elokuussa 2026 yhteensä 30,97 €.");
 const response=await ask("Entä heinäkuussa 2026?");
 expect(response.request().postDataJSON().context).toEqual({tool:"showTransactions",input:{period:{start:"2026-08-01",end:"2026-09-01"},category:"taxi",merchant:"MRC-TRN-0063"}});
 await expect(answers(page).last().locator("dl")).toContainText("MRC-TRN-0063");
});

test("Finnish answer remains visible when the chat route is unavailable",async({page})=>{
 await page.addInitScript(()=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:"fi",savings:10})));
 await page.goto("/demo?dataset=organizer1&tab=coach");
 await page.route("**/api/chat",route=>route.fulfill({status:503,headers:{"cache-control":"private, no-store"},body:""}));
 await page.getByRole("textbox",{name:"Kysymyksesi",exact:true}).fill(cases[2].question);
 await page.getByRole("button",{name:"Lähetä kysymys",exact:true}).click();
 await expect(answers(page).locator("[data-spoken-answer]")).toHaveText(cases[2].sentence);
 await expect(page.getByText("Verkkovastaus ei ollut saatavilla. Vastaus käyttää samaa paikallista aineistoa.",{exact:true})).toBeVisible();
 await expect(page.getByRole("textbox",{name:"Kysymyksesi",exact:true})).toBeEnabled();
});
