import {openOverview} from "../view-navigation";
import {checkBasis} from "../basis";
import {test,expect,type Locator} from "@playwright/test";
import path from "node:path";

async function choose(scope:Locator,start:string,through:string) {
  await scope.getByRole("button",{name:"Choose period",exact:true}).click();
  await scope.getByLabel("From",{exact:true}).fill(start);
  await scope.getByLabel("Through",{exact:true}).fill(through);
  await scope.getByRole("button",{name:"Show period",exact:true}).click();
}

test("period drafts cancel, invalid dates preserve totals and chart refinements show their actual scope",async({page})=>{
 await page.goto('/?question='+encodeURIComponent('Where did my money go last month?'));await page.getByRole('button',{name:'Send question',exact:true}).click();const answer=page.locator('article').last(),trigger=answer.getByRole('button',{name:'Choose period',exact:true}),sheet=page.getByRole('dialog');
 await expect(answer).toContainText('864,50');await trigger.click();await sheet.getByLabel('From',{exact:true}).fill('2026-09-01');await page.keyboard.press('Escape');await trigger.click();await expect(sheet.getByLabel('From',{exact:true})).toHaveValue('2026-10-01');
 await sheet.getByLabel('From',{exact:true}).fill('2026-11-02');await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(sheet.getByRole('alert')).toHaveText('Use valid dates in chronological order.');await expect(answer).toContainText('864,50');
 await sheet.getByLabel('From',{exact:true}).fill('2026-11-01');await sheet.getByLabel('Through',{exact:true}).fill('2026-11-01');await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(answer).toContainText('12,50');await expect(answer.locator('svg.recharts-surface')).toHaveCount(0);await answer.getByRole('button',{name:/12,50/}).click();await expect(page.getByRole('dialog')).toContainText('12,50');await page.getByRole('button',{name:'Done',exact:true}).click();
 await trigger.click();await sheet.getByRole('button',{name:'Previous calendar month',exact:true}).last().click();await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(answer).toContainText('864,50');await expect(answer.getByRole('button',{name:/350,00/})).toBeVisible();await checkBasis(page,answer,undefined,'1.10.2026 to 31.10.2026');
 await trigger.click();await sheet.getByLabel('Through',{exact:true}).fill('2026-10-01');await sheet.getByRole('button',{name:'Show period',exact:true}).click();await expect(answer).toContainText('No recorded transactions');await expect(answer).not.toContainText('0,00');await checkBasis(page,answer,undefined,'1.10.2026 to 1.10.2026');
});
