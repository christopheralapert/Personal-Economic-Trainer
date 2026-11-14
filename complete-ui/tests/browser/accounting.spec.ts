import {openOverview} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";
import {en} from "../../src/i18n/dictionaries";
const captures=path.resolve(__dirname,"../../../.impeccable/review/money-coach");

test("empty source periods withhold summary and basket totals while a recorded period restores them",async({page})=>{
 await page.goto('/?question='+encodeURIComponent('Where did my money go from 2026-11-02 through 2026-11-02?'));await page.getByRole('button',{name:en.send,exact:true}).click();let answer=page.locator('article').last();await expect(answer).toContainText(en.emptyRecords);await expect(answer).not.toContainText('0,00');
 await page.getByRole('textbox',{name:en.questionLabel,exact:true}).fill('Show my three baskets from 2026-11-02 through 2026-11-02');await page.getByRole('button',{name:en.send,exact:true}).click();answer=page.locator('article').last();await expect(answer.getByText(en.notRecorded,{exact:true})).toHaveCount(3);
 await page.getByRole('textbox',{name:en.questionLabel,exact:true}).fill('Where did my money go last month?');await page.getByRole('button',{name:en.send,exact:true}).click();await expect(page.locator('article').last()).toContainText('864,50');await expect(page.locator('article').last()).not.toContainText(en.notRecorded);
});

test("explicit injected category fixtures reconcile refunds and distinguish Other from the remainder",async({page})=>{
  // Test-only native SDK output; the production fixture is unchanged.
  let refundOnly=false;
  const sourceLabel="A".repeat(160);
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch();
    const group=(key:string,gross:number,refunds=0)=>({key,gross,refunds,amount:gross-refunds,count:1});
    const groups=refundOnly ? [group("constructor",0,200)] : [group("other",5000),group("dining",4000),group("taxi",3000),group("coffee",2000),group("send",1000,300),group("constructor",0,200),group(sourceLabel,0,100)];
    const body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;const part=JSON.parse(line.slice(6));if(part.type==="tool-output-available") part.output.groups=groups;return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();
  const input=page.getByRole("textbox",{name:en.questionLabel,exact:true}),send=page.getByRole("button",{name:en.send,exact:true});
  await input.fill("Where did my money go last month?");await send.click();const answer=page.locator("article").last();
  await expect(answer).toContainText("144,00");await expect(answer.getByRole("table")).toContainText("send");await expect(answer.getByRole("table").getByRole("row")).toHaveCount(8);
  const other=answer.getByRole("button",{name:/50,00.*Other/}),remainder=answer.getByRole("button",{name:/27,00.*Other categories/});
  await other.click();let detail=page.getByRole("dialog",{name:en.other,exact:true});await expect(detail).toContainText(en.emptyRecords);await detail.getByRole("button",{name:en.done,exact:true}).click();
  await remainder.click();detail=page.getByRole("dialog",{name:en.remainingCategories,exact:true});await expect(detail).toContainText("Coffee purchases");await expect(detail).toContainText("16,50");await detail.getByRole("button",{name:en.done,exact:true}).click();
  // Injected chart figures are not invented ledger records: their full reconciliation stays in the table.
  await expect(answer.getByRole("table")).toContainText("7,00");await expect(answer.getByRole("table")).toContainText("20,00");
  await expect(answer.getByRole("heading",{name:en.withoutGross,exact:true})).toBeVisible();await expect(answer).toContainText("constructor");
  await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});
  for(const width of [360,390,430,768]){await page.setViewportSize({width,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});await page.setViewportSize({width:390,height:844});
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/chart-refunds-${colorScheme}.png`,fullPage:true});}
  refundOnly=true;await input.fill("Where did my money go last month?");await send.click();
  await expect(answer).toContainText("−2,00");await expect(answer.locator("svg.recharts-surface")).toHaveCount(0);await expect(answer.getByRole("table")).toContainText(en.notAvailable);
  await expect(answer).not.toContainText("NaN");await expect(answer.locator("button[aria-pressed]")).toHaveCount(0);
});
