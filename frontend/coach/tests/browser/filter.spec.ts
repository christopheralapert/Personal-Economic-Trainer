import {openRecords} from "../view-navigation";
import {test,expect} from "@playwright/test";
import path from "node:path";

test("transaction filter discards dismissed drafts and reopens with the applied selection",async({page})=>{
 await page.goto('/');await openRecords(page);const answer=page.locator('article').last(),trigger=answer.getByRole('button',{name:'Filter transactions',exact:true}),sheet=page.getByRole('dialog');
 await trigger.click();await sheet.getByLabel('Reserved',{exact:true}).check();await page.keyboard.press('Escape');await expect(sheet).toHaveCount(0);await expect(answer).toContainText('Taxi Helsinki');
 await trigger.click();await expect(sheet.getByLabel('All transactions',{exact:true})).toBeChecked();await sheet.getByLabel('Reserved',{exact:true}).check();await sheet.getByRole('button',{name:'Done',exact:true}).click();await expect(answer).toContainText('No recorded transactions');
 await trigger.click();await expect(sheet.getByLabel('Reserved',{exact:true})).toBeChecked();await sheet.getByLabel('Booked',{exact:true}).check();await page.keyboard.press('Escape');await expect(answer).toContainText('No recorded transactions');
 await page.getByRole('tab',{name:'Learn',exact:true}).click();await page.getByRole('tab',{name:'Coach',exact:true}).click();await trigger.click();await expect(sheet.getByLabel('Reserved',{exact:true})).toBeChecked();await sheet.getByLabel('All transactions',{exact:true}).check();await sheet.getByRole('button',{name:'Done',exact:true}).click();await expect(answer).toContainText('Taxi Helsinki');
});
