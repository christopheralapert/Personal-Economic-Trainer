import {expect,type Page} from "@playwright/test";
import {en} from "../src/i18n/dictionaries";
export async function openOverview(page:Page,copy=en) {const tab=page.getByRole("tab",{name:copy.overview,exact:true});if(await tab.count())await tab.click();else await page.getByRole("button",{name:copy.overview,exact:true}).click();}
export async function openRecords(page:Page,copy=en) {await page.getByRole("tab",{name:copy.coach,exact:true}).click();await page.getByRole("textbox",{name:copy.questionLabel,exact:true}).fill(copy.retryStatusAll);await page.getByRole("button",{name:copy.send,exact:true}).click();await expect(page.locator("article").last().getByRole("button",{name:copy.filter,exact:true})).toBeVisible();}
export async function expectExtendedSource(page:Page) {await expect(page.locator('[data-overview-block="categories"] [data-chart-total]')).toHaveAttribute('data-chart-total','178810');}
