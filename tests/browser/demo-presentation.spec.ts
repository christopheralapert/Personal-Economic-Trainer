import {test,expect} from "./demo-support";
import {fi} from "../../frontend/coach/src/i18n/dictionaries";
import organizer from "../../frontend/coach/data/organizer-1.v1.json";

const question="Paljonko käytin takseihin viime kuussa?";
const sentence=/Käytit takseihin elokuussa 2026 yhteensä 30,97\s€\./;
const september={start:"2026-09-01",end:"2026-10-01"};

for(const width of [390,360])test(`Finnish organizer presentation at ${width}px opens evidence and saves 159,58 €`,async({page,demoTraffic},testInfo)=>{
  await page.setViewportSize({width,height:844});
  await page.goto("/demo?dataset=organizer1");
  await expect(page.locator("header")).toContainText("30.9.2026");
  // Choose Finnish through the real settings flow, without seeding a translated answer.
  await page.getByRole("button",{name:"Settings",exact:true}).click();
  await page.getByRole("radio",{name:"Suomi",exact:true}).check();
  await page.getByRole("button",{name:fi.back,exact:true}).click();
  await expect(page.locator('[data-overview-block="period"]')).toContainText("syyskuu 2026");
  const baskets=page.locator('[data-overview-block="baskets"]');
  for(const [label,id] of [["Säännölliset","mandatory_regular"],["Yllätykset","mandatory_irregular"],["Arki","everyday"]]){
    const basket=baskets.getByRole("button",{name:new RegExp(`^${label} `)});
    await expect(basket).toBeVisible();await basket.click();
    await expect(page.locator(`#learn-${id}`)).toBeVisible();
    await page.getByRole("tab",{name:fi.overview,exact:true}).click();
  }
  // Unreviewed payments are shown separately from the three classified baskets and own the review action.
  await expect(baskets.getByText("Tarkistettavat",{exact:true})).toBeVisible();
  await expect(baskets.getByRole("button",{name:"Tarkista",exact:true})).toBeVisible();
  await page.screenshot({path:testInfo.outputPath("overview-fi.png"),fullPage:true,animations:"disabled"});
  await page.locator("#home-question").fill(question);await page.locator("#home-question").press("Enter");
  const answers=page.locator('[data-message-role="assistant"]'),answer=answers.first();
  await expect(page.locator('[data-message-role="user"]').first()).toHaveText(question);
  await expect(answer.locator("[data-spoken-answer]")).toHaveText(sentence);
  await expect(answer).toContainText(fi.modeRules);
  expect(demoTraffic.chat[0]).toMatchObject({dataset:"organizer1",locale:"fi",period:september,privacy:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  for(const colorScheme of ["light","dark"] as const){
    await page.emulateMedia({colorScheme});
    await page.screenshot({path:testInfo.outputPath(`answer-fi-${colorScheme}.png`),animations:"disabled"});
  }
  const taxiRows=organizer.profiles[0].transactions.filter(row=>row.category==="taxi"&&row.booked_on>="2026-08-01"&&row.booked_on<"2026-09-01");
  expect(taxiRows).toHaveLength(1);expect(taxiRows[0].amount_minor).toBe(-3097);
  await answer.getByRole("button",{name:taxiRows[0].merchant,exact:true}).click();
  const details=page.getByRole("dialog",{name:fi.transactionDetailTitle,exact:true});
  await expect(details).toContainText(taxiRows[0].merchant);await expect(details).toContainText("26.8.2026");
  await expect(details).toContainText(fi.taxi);await expect(details).toContainText(/−30,97\s€/);
  await page.screenshot({path:testInfo.outputPath("transaction-fi.png"),animations:"disabled"});
  await details.getByRole("button",{name:fi.done,exact:true}).click();
  const input=page.getByRole("textbox",{name:fi.questionLabel,exact:true});
  await input.fill("Entä jos vähennän ulkona syömistä 20%?");
  await page.getByRole("button",{name:fi.send,exact:true}).click();
  await expect(answers).toHaveCount(2);const scenario=answers.last();
  await expect(scenario).toContainText(/159,58\s€/);
  await expect(scenario).toContainText("1.9.2026–30.9.2026");
  await expect(scenario.getByRole("slider")).toHaveAttribute("aria-valuenow","20");
  expect(demoTraffic.chat[1]).toMatchObject({dataset:"organizer1",locale:"fi",period:september});
  await page.getByRole("tab",{name:fi.whatif,exact:true}).click();
  await expect(page.locator("main")).toContainText("syyskuu 2026");
  const dining=page.getByRole("region",{name:fi.combined,exact:true});
  await dining.getByRole("button",{name:new RegExp(`^${fi.dining} ·`)}).click();
  const slider=dining.getByRole("slider",{name:`${fi.reduce} ${fi.dining}`,exact:true});await expect(slider).toHaveAttribute("aria-valuenow","20");
  await expect(dining).toContainText(/−159,58\s€/);
  // Changing and restoring the percentage verifies a live calculation, not static copy.
  await slider.focus();await page.keyboard.press("Home");await expect(dining).toContainText(/−0,00\s€/);
  await page.getByRole("button",{name:fi.resetScenario,exact:true}).click();
  await expect(slider).toHaveAttribute("aria-valuenow","20");await expect(dining).toContainText(/−159,58\s€/);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath("scenario-fi.png"),fullPage:true,animations:"disabled"});
  expect(demoTraffic.chat).toHaveLength(2);expect(demoTraffic.privatePaths).toEqual([]);
});

for(const [path,label] of [["/","Try with demo data"],["/access","Try the demo"],["/demo/banks","Try with demo data"]]){
  test(`public entry ${path} opens organizer1 after a different saved profile`,async({page,demoTraffic})=>{
    await page.addInitScript(()=>localStorage.setItem("money-coach-dataset.v1","extended"));
    await page.goto(path);
    const demo=page.getByRole("link",{name:label,exact:true});
    await expect(demo).toHaveAttribute("href","/demo?dataset=organizer1");await demo.click();
    await expect(page.locator("header")).toContainText("30.9.2026");
    await expect(page.locator('[data-overview-block="period"]')).toContainText("September 2026");
    expect(demoTraffic.privatePaths).toEqual(path==="/"?["/api/v1/auth/session"]:[]);
  });
}

test("bank rehearsal header and all four tabs enter the organizer presentation",async({page,demoTraffic})=>{
  await page.addInitScript(()=>localStorage.setItem("money-coach-dataset.v1","starter"));
  for(const [tab,label] of [["overview","Overview"],["coach","Coach"],["whatif","What if"],["learn","Learn"]]){
    await page.goto("/demo/banks");
    const link=page.getByRole("navigation").getByRole("link",{name:label,exact:true});
    await expect(link).toHaveAttribute("href",`/demo?dataset=organizer1&tab=${tab}`);await link.click();
    await expect(page.locator("header")).toContainText("30.9.2026");
    await expect(page.getByRole("tab",{name:label,exact:true})).toHaveAttribute("aria-selected","true");
  }
  await page.goto("/demo/banks");await page.locator("header").getByRole("link",{name:"Money Coach",exact:true}).click();
  await expect(page.locator('[data-overview-block="period"]')).toContainText("September 2026");
  expect(demoTraffic.privatePaths).toEqual([]);
});
