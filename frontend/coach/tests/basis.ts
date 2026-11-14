import {expect,type Page,type Locator} from "@playwright/test";
import {en,fi,et} from "../src/i18n/dictionaries";
/** Assert the full evidence through the new compact disclosure rather than dropping coverage. */
export async function checkBasis(page:Page,scope:Locator,copy:typeof en|typeof fi|typeof et=en,contains?:string) {
 await scope.getByRole("button",{name:copy.basisTitle,exact:true}).click();
 const sheet=page.getByRole("dialog",{name:copy.basisTitle,exact:true});await expect(sheet).toContainText(copy.partial);
 if(contains)await expect(sheet).toContainText(contains);
 await sheet.getByRole("button",{name:copy.done,exact:true}).click();
}
