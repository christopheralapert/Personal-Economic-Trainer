import {test,expect,type Page} from "@playwright/test";
import {en,fi,et} from "../../frontend/coach/src/i18n/dictionaries";
import {learningCopy} from "../../frontend/coach/src/i18n/learning";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";
import {analysisTotals} from "./analysis-support";

for(const [locale,copy] of [["en",en],["fi",fi],["et",et]] as const)test(`Learn ${locale}: all six lessons, keyboard, scoped evidence and no automatic model call`,async({page},info)=>{
 const calls:unknown[]=[];
 await page.addInitScript(locale=>localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:10})),locale);
 page.on("request",r=>{if(new URL(r.url()).pathname==="/api/chat")calls.push(r.postDataJSON());});
 await page.route("**/api/v1/auth/session",r=>r.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED"}}}));
 await page.goto("/demo?dataset=organizer1&tab=learn");
 const names=[copy.regularShort,copy.surprisesShort,copy.everydayShort,copy.fund,copy.savingConcept,copy.habit];
 for(const [i,name] of names.entries()){
  const button=page.getByRole("button",{name:new RegExp(`^${name} `)});
  await button.focus();await button.press("Enter");await expect(button).toHaveAttribute("aria-expanded","true");
  const region=page.getByRole("region",{name:new RegExp(`^${name} `)});
  await expect(region.getByRole("heading",{name:learningCopy[locale].next,exact:true})).toBeVisible();
  await expect(region.getByRole("button",{name:copy.askCoach,exact:true})).toBeVisible();
  expect(calls).toHaveLength(0);
  if(i===2){await page.screenshot({path:info.outputPath(`learn-${locale}.png`),fullPage:true,animations:"disabled"});}
 }
 await expect(page.getByRole("status").filter({hasText:learningCopy[locale].progress.replace("{count}","6").replace("{total}","6")})).toBeVisible();
 await page.getByRole("button",{name:new RegExp(`^${copy.everydayShort} `)}).click();
 await page.getByRole("region",{name:new RegExp(`^${copy.everydayShort} `)}).getByRole("button",{name:learningCopy[locale].records,exact:true}).click();
 await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(1);
 expect(calls).toHaveLength(1);expect(JSON.stringify(calls[0])).toContain("everyday");expect(JSON.stringify(calls[0])).toContain("2026-09-01");
 const row=page.locator('[data-message-role="assistant"] li button').first();await row.click();await expect(page.getByRole("dialog")).toBeVisible();
 await page.getByRole("dialog").getByRole("button",{name:copy.done,exact:true}).click();await page.getByRole("tab",{name:copy.learn,exact:true}).click();
 await page.getByRole("button",{name:new RegExp(`^${copy.habit} `)}).click();await page.getByRole("region",{name:new RegExp(`^${copy.habit} `)}).getByRole("button",{name:copy.askCoach,exact:true}).click();
 await expect(page.locator('[data-message-role="assistant"]')).toHaveCount(2);expect(calls).toHaveLength(2);
 expect(JSON.stringify(calls[1])).toContain("entertainment");expect(JSON.stringify(calls[1])).toContain("2026-09-01");
 await expect(page.locator('[data-message-role="assistant"]').last()).toContainText(copy.entertainment);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

async function privateData(page:Page,{fail=false,empty=false}={}){
 const ids=["00000000-0000-0000-0000-000000000101","00000000-0000-0000-0000-000000000102"];
 let failed=fail;const calls:Record<string,unknown>[]=[];
 await page.clock.install({time:new Date(fixture.clock)});
 await page.route("**/api/v1/**",async route=>{
  const path=new URL(route.request().url()).pathname.replace("/api/v1/","");
  const reply=(json:unknown,status=200)=>route.fulfill({status,json});
  if(path==="auth/session")return reply({...fixture.session,synthetic:false});
  if(path==="dashboard")return reply({data_version:7,synthetic:false,live_banking_enabled:false,model_policy:"free_only",accounts:ids.map((id,i)=>({id,name:`Synthetic account ${i+1}`,currency:"EUR",included:true,access_status:"observed",balance:null,source:null}))});
  if(path==="accounts")return reply(ids.map((id,i)=>({id,name:`Synthetic account ${i+1}`,currency:"EUR",included:true})));
  if(path==="analysis/tools/execute"){
   const body=route.request().postDataJSON();calls.push(body);if(failed){failed=false;return reply({error:{code:"UNAVAILABLE"}},503);}
   const result=analysisTotals(body.arguments);if(empty)Object.assign(result,{gross_minor:0,net_minor:0,expense_count:0,category_baskets:[]});
   return reply({name:"spending_totals",result});
  }
  return reply({},404);
 });return {ids,calls};
}
test("private Learn uses owned account/period, keeps reading local, and prepares an editable Coach question",async({page},info)=>{
 const {ids,calls}=await privateData(page);await page.goto("/learn");
 await expect(page.locator("#everyday")).toContainText("October 2026");
 await page.getByRole("combobox",{name:"Accounts",exact:true}).selectOption(ids[0]);
 await expect.poll(()=>JSON.stringify(calls.at(-1))).toContain(ids[0]);
 await page.getByRole("button",{name:/^Everyday /}).click();
 const region=page.getByRole("region",{name:/^Everyday /});
 await expect(region.getByRole("link",{name:"View transactions",exact:true})).toHaveAttribute("href",new RegExp(`start=2026-10-01.*end=2026-11-01.*account_id=${ids[0]}`));
 for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:info.outputPath(`private-learn-${colorScheme}.png`),fullPage:true,animations:"disabled"});}
 await region.getByRole("button",{name:en.askCoach,exact:true}).click();await expect(page).toHaveURL(/\/coach\?/);
 await expect(page.getByLabel("Question (English)",{exact:true})).toHaveValue(/2026-10-01.*2026-10-31/);
 await expect(page.getByLabel("Account scope",{exact:true})).toHaveValue(ids[0]);
 const storage=await page.evaluate(()=>Object.entries(localStorage));expect(storage.some(([key])=>key==="money-coach-learning.v1")).toBe(false);
});
test("private Learn distinguishes a load failure from empty history and retries",async({page})=>{
 await privateData(page,{fail:true});await page.goto("/learn");await expect(page.locator("main").getByRole("alert")).toBeVisible();
 await expect(page.getByText(learningCopy.en.noFacts,{exact:true})).toHaveCount(0);
 await page.locator("main").getByRole("alert").getByRole("button").click();await expect(page.locator("main").getByRole("alert")).toHaveCount(0);
 await expect(page.locator("#everyday")).toContainText("October 2026");
 await page.getByRole("button",{name:"Previous month",exact:true}).click();
 await expect(page.getByRole("heading",{name:"September 2026",exact:true})).toBeVisible();
});
test("private Learn without confirmed spending still teaches and offers a recovery",async({page})=>{
 await privateData(page,{empty:true});await page.goto("/learn");await expect(page.getByText(learningCopy.en.noFacts,{exact:true})).toBeVisible();
 await page.getByRole("button",{name:/^Emergency fund /}).click();await expect(page.getByRole("region",{name:/^Emergency fund /})).toContainText(learningCopy.en.fund.step);
 await expect(page.locator("#fund")).not.toContainText("0,00");
});

test("design visual and accessibility sweep: desktop/mobile, both themes and major tabs",async({page},info)=>{
 await page.route("**/api/v1/auth/session",r=>r.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED"}}}));
 for(const width of [390,1280])for(const colorScheme of ["light","dark"] as const){
  await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme});await page.goto("/demo?dataset=organizer1");
  for(const tab of [en.overview,en.coach,en.whatif,en.learn]){
   await page.getByRole("tab",{name:tab,exact:true}).click();if(tab===en.learn)await page.getByRole("button",{name:/^Regular /}).click();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:info.outputPath(`${width}-${colorScheme}-${tab.replaceAll(" ","-")}.png`),fullPage:true,animations:"disabled"});
   await page.addScriptTag({path:require.resolve("axe-core")});
   const violations=await page.evaluate(async()=>{const axe=(window as unknown as {axe:{run:(ctx:Document,opts:unknown)=>Promise<{violations:{id:string;nodes:{target:unknown;failureSummary:string}[]}[]}>}}).axe;return (await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>({target:n.target,reason:n.failureSummary}))}));});
   expect.soft(violations,`${width} ${colorScheme} ${tab}`).toEqual([]);
  }
 }
});
