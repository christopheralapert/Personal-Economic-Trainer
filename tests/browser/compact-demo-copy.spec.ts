import {test,expect} from "./demo-support";
import {en,fi,et} from "../../frontend/coach/src/i18n/dictionaries";
import {learningCopy} from "../../frontend/coach/src/i18n/learning";

for(const [locale,copy] of[["en",en],["fi",fi],["et",et]] as const)test(`${locale}: compact Coach, Learn and What if preserve facts and controls`,async({page},info)=>{
 await page.addInitScript(locale=>{
  localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:10}));
  localStorage.setItem("money-coach-privacy.v1","true");
 },locale);
 const start=new Intl.DateTimeFormat(locale,{month:"short",day:"numeric",timeZone:"UTC"}).format(new Date("2026-09-01T12:00:00Z"));
 await page.goto("/demo?dataset=organizer1&tab=coach");
 await page.getByRole("textbox",{name:copy.questionLabel,exact:true}).fill(copy.qSafe);
 await page.getByRole("button",{name:copy.send,exact:true}).click();
 const answer=page.locator('[data-message-role="assistant"]').last();
 await expect(answer.getByRole("heading",{name:copy.week,exact:true})).toBeVisible();
 await expect(answer.getByText(copy.safeNote,{exact:true})).toHaveCount(0);
 await expect(answer.getByText(copy.confidenceLow,{exact:true})).toBeVisible();
 await expect(answer).toContainText(/599,17\s€/);await expect(answer).toContainText(/998,63\s€/);
 // With the removed intro gone, the real card is the first element, not an empty paragraph.
 expect(await answer.evaluate(node=>node.firstElementChild?.querySelector('h2')?.textContent)).toBe(copy.week);
 const calculation=answer.getByRole("button",{name:copy.calculation,exact:true});
 await calculation.click();let dialog=page.getByRole("dialog",{name:copy.calculation,exact:true});
 await expect(dialog).toContainText(copy.availableBalance);await dialog.getByRole("button",{name:copy.done,exact:true}).click();
 await expect(answer.getByRole("button",{name:copy.basisTitle,exact:true})).toContainText(copy.partialChip);
 await expect(answer.getByRole("button",{name:copy.basisTitle,exact:true})).toContainText(start);
 await answer.getByRole("button",{name:copy.basisTitle,exact:true}).click();
 dialog=page.getByRole("dialog",{name:copy.basisTitle,exact:true});await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:copy.done,exact:true}).click();
 await answer.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("coach.png"),animations:"disabled"});

 await page.getByRole("tab",{name:copy.learn,exact:true}).click();
 const learn=page.getByRole("tabpanel",{name:copy.learn,exact:true});
 await expect(learn.getByText(learningCopy[locale].note,{exact:true})).toHaveCount(0);
 for(const name of[copy.regularShort,copy.surprisesShort,copy.everydayShort,copy.fund,copy.savingConcept,copy.habit]){
  const button=learn.getByRole("button",{name:new RegExp(`^${name} `)});await button.click();
  await expect(button).toHaveAttribute("aria-expanded","true");
  await expect(learn.getByRole("region",{name:new RegExp(`^${name} `)})).toContainText(learningCopy[locale].next);
 }
 const learnBasis=learn.getByRole("button",{name:copy.basisTitle,exact:true});await expect(learnBasis).toContainText(copy.partialChip);
 await expect(learnBasis).toContainText(start);
 await learnBasis.click();dialog=page.getByRole("dialog",{name:copy.basisTitle,exact:true});await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:copy.done,exact:true}).click();
 await learnBasis.scrollIntoViewIfNeeded();await page.evaluate(()=>{if(document.activeElement instanceof HTMLElement)document.activeElement.blur();});
 await page.screenshot({path:info.outputPath("learn.png"),fullPage:true,animations:"disabled"});

 await page.getByRole("tab",{name:copy.whatif,exact:true}).click();
 const scenario=page.getByRole("tabpanel",{name:copy.whatif,exact:true}),card=scenario.getByRole("region",{name:copy.combined,exact:true});
 await expect(scenario.getByText(copy.assumption,{exact:true})).toHaveCount(0);
 await expect(card).toContainText(/667,26\s€/);await expect(card).toContainText(/8\s?007,12\s€/);
 await card.getByRole("button",{name:new RegExp(`^${copy.dining} ·`)}).click();
 const slider=card.getByRole("slider",{name:`${copy.reduce} ${copy.dining}`,exact:true});
 await expect(slider).toHaveAttribute("aria-valuenow","20");await expect(card).toContainText(/−159,58\s€/);
 await slider.focus();await slider.press("Home");await expect(slider).toHaveAttribute("aria-valuenow","0");
 await card.getByRole("button",{name:copy.resetScenario,exact:true}).click();await expect(slider).toHaveAttribute("aria-valuenow","20");
 await expect(card).toContainText(/667,26\s€/);
 const plan=card.getByRole("button",{name:copy.setAside.replace("{amount}","667,26 €"),exact:true});
 await plan.click();dialog=page.getByRole("dialog");await expect(dialog.getByRole("textbox")).toBeVisible();
 await dialog.getByRole("button",{name:copy.close,exact:true}).click();
 const basis=scenario.getByRole("button",{name:copy.basisTitle,exact:true});await expect(basis).toContainText(copy.partialChip);
 await expect(basis).toContainText(start);
 // The period/info control is now directly after the card; no redundant wrapper survives.
 expect(await card.evaluate(node=>node.nextElementSibling?.tagName)).toBe("BUTTON");
 await basis.click();dialog=page.getByRole("dialog",{name:copy.basisTitle,exact:true});await expect(dialog).toBeVisible();
 await dialog.getByRole("button",{name:copy.done,exact:true}).click();
 await card.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath("whatif.png"),fullPage:true,animations:"disabled"});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
