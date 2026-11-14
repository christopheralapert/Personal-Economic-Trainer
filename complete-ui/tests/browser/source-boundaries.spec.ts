import {openOverview} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";
const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("date presets remain drafts and future dates cannot change the snapshot-based overview",async({page})=>{
 await page.goto('/?question='+encodeURIComponent('Where did my money go last month?'));await page.getByRole('button',{name:'Send question',exact:true}).click();const answer=page.locator('article').last(),trigger=answer.getByRole('button',{name:'Choose period',exact:true}),sheet=page.getByRole('dialog');await trigger.click();await sheet.getByRole('button',{name:'Snapshot month to date',exact:true}).click();await expect(sheet.getByLabel('From',{exact:true})).toHaveValue('2026-11-01');await expect(sheet.getByLabel('Through',{exact:true})).toHaveValue('2026-11-04');await expect(answer).toContainText('864,50');await page.keyboard.press('Escape');await trigger.click();await expect(sheet.getByLabel('From',{exact:true})).toHaveValue('2026-10-01');await sheet.getByLabel('Through',{exact:true}).fill('2026-11-05');await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(sheet.getByRole('alert')).toHaveText('Choose dates on or before the source snapshot.');await expect(answer).toContainText('864,50');await sheet.getByRole('button',{name:'Snapshot month to date',exact:true}).click();await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(answer).toContainText('12,50');
});

test("fractional scenarios retain exact percentage and incomplete balance payloads stay unavailable",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("tab",{name:"Coach",exact:true}).click();const input=page.getByRole("textbox",{name:"Your question",exact:true}),send=page.getByRole("button",{name:"Send question",exact:true});
  await input.fill("What if I cut dining out by 20.25%?");await send.click();let answer=page.locator("article").last();
  await expect(answer).toContainText("50,63");await expect(answer.getByRole("slider")).toHaveAttribute("aria-valuenow","20.25");
  await expect(answer.getByRole("slider")).toHaveAttribute("aria-valuetext",/20,25/);
  await page.route("**/api/chat",async route=>{
    const response=await route.fetch();
    const body=(await response.text()).split("\n").map(line=>{
      if(!line.startsWith("data: {")) return line;
      const part=JSON.parse(line.slice(6));
      if(part.type==="tool-output-available"){part.output.result.balance=null;part.output.result.illustrativeHeadroom=null;part.output.result.reasons.push("balances_missing");}
      return `data: ${JSON.stringify(part)}`;
    }).join("\n");await route.fulfill({response,body});
  });
  await input.fill("What is safe for me to spend this week?");await send.click();answer=page.locator("article").last();
  await expect(answer).toContainText("A usable balance is missing for one or more included accounts.");
  await expect(answer).toContainText("Transaction history is incomplete.");await expect(answer).toContainText("Upcoming bills and essential reserves need review.");
  await expect(answer).toContainText("Source snapshot: 4.11.2026");
  await answer.getByRole("button",{name:"How is this calculated?",exact:true}).click();
  await expect(answer.getByText("Observed available balance",{exact:true})).toHaveCount(0);
  await expect(answer.getByText("Illustrative headroom after recorded reserves",{exact:false})).toHaveCount(0);await expect(answer).not.toContainText("Add your monthly income");
  await expect(answer).not.toContainText("800,00");await expect(answer).not.toContainText("200,00");
  for(const colorScheme of ["light","dark"] as const){await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/balance-unknown-${colorScheme}.png`,fullPage:true});}
});
