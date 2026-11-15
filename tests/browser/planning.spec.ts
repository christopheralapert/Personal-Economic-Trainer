import {test, expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";
import {mockPlanning, signInPlanning} from "./planning-support";

test("reviewed planning UI creates a plan and reserves/releases one shared surplus using domain fixtures", async ({page}) => {
  const calls = await mockPlanning(page);
  await signInPlanning(page);
  await expect(page.getByRole("heading",{name:"Review your next 30 days"})).toBeVisible();
  await page.getByRole("button",{name:"Calculate and save reviewed plan"}).click();
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Confirm the reviewed period");
  expect(calls.creates).toHaveLength(0);
  await page.getByLabel("Money unavailable to spend (EUR)").fill("0");
  await page.getByLabel("I reviewed this account's current information.").check();
  for (const [label, value] of [["Essential living costs","150"],["Irregular essentials","0"],["Existing savings commitments","0"],["Safety buffer","100"]])
    await page.locator(".protection-group").filter({has:page.getByRole("heading",{name:label,exact:true})}).getByRole("textbox").fill(value);
  await page.getByLabel(/I reviewed all four protections/).check();
  await page.getByRole("button",{name:"Calculate and save reviewed plan"}).click();
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  expect(calls.creates).toHaveLength(1);
  expect(calls.creates[0]).not.toHaveProperty("as_of");
  await page.getByLabel("Keep for discretionary spending (EUR)").fill("100");
  await page.getByLabel("Proposed new savings (EUR)").fill("50");
  await page.getByLabel("Account funding the reservation").selectOption({label:"Everyday account"});
  await page.getByRole("button",{name:"Preview allocation",exact:true}).click();
  await expect(page.locator(".allocation-preview")).toContainText("150,00");
  expect(calls.accepts).toHaveLength(0);
  await page.getByRole("button",{name:"Confirm savings reservation"}).click();
  await expect(page.getByTestId("private-spending-room")).toContainText("150,00");
  await expect(page.locator(".reservation-list")).toContainText("Reserved");
  await page.reload();
  await expect(page.getByTestId("private-spending-room")).toContainText("150,00");
  await page.getByRole("button",{name:/Release .* reservation/}).click();
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  await expect(page.locator(".reservation-list")).toContainText("Released");
  expect(calls.accepts).toHaveLength(1); expect(calls.releases).toHaveLength(1);
  await page.getByRole("link",{name:"Settings",exact:true}).click();
  await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await expect(page.getByRole("link",{name:"Try file import",exact:true})).toBeVisible();
  await expect(page.getByTestId("private-spending-room")).toHaveCount(0);
  expect(await page.evaluate(() => ({local:localStorage.length,session:sessionStorage.length}))).toEqual({local:0,session:0});
});

test("ambiguous savings response hides guidance and manual retry reuses exactly one command", async ({page}) => {
  const calls = await mockPlanning(page,{initial:"saved",failAcceptOnce:true});
  await signInPlanning(page);
  await page.getByLabel("Keep for discretionary spending (EUR)").fill("100");
  await page.getByLabel("Proposed new savings (EUR)").fill("50");
  await page.getByLabel("Account funding the reservation").selectOption({label:"Everyday account"});
  await page.getByRole("button",{name:"Preview allocation",exact:true}).click();
  await page.getByRole("button",{name:"Confirm savings reservation"}).click();
  await expect(page.getByRole("button",{name:"Retry the same savings request"})).toBeVisible();
  await expect(page.getByTestId("private-spending-room")).toContainText("Review needed");
  expect(calls.accepts).toHaveLength(1);
  await page.getByRole("button",{name:"Retry the same savings request"}).click();
  await expect(page.getByTestId("private-spending-room")).toContainText("150,00");
  expect(calls.accepts).toHaveLength(2);
  expect(calls.accepts[1]).toEqual(calls.accepts[0]);
});

test("offline and background transitions clear drafts and never replay writes", async ({page,context}) => {
  const calls = await mockPlanning(page,{initial:"saved"});
  await signInPlanning(page);
  await page.getByLabel("Proposed new savings (EUR)").fill("73.50");
  await context.setOffline(true);
  await expect(page.getByTestId("private-spending-room")).toHaveCount(0);
  await expect(page.getByRole("main")).toContainText("You are offline");
  await context.setOffline(false);
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  await expect(page.getByLabel("Proposed new savings (EUR)")).toHaveValue("");
  expect(calls.accepts).toHaveLength(0);
  const hiddenCleared = await page.evaluate(() => {
    Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});
    document.dispatchEvent(new Event("visibilitychange"));
    return document.querySelector('[data-testid="private-spending-room"]') === null;
  });
  expect(hiddenCleared).toBe(true);
  await expect(page.getByTestId("private-spending-room")).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"visible"});
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  expect(calls.accepts).toHaveLength(0);
  const pageHideCleared = await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}));
    return document.querySelector('[data-testid="private-spending-room"]') === null;
  });
  expect(pageHideCleared).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})));
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  const offlineCleared = await page.evaluate(() => {
    window.dispatchEvent(new Event("offline"));
    return document.querySelector('[data-testid="private-spending-room"]') === null;
  });
  expect(offlineCleared).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
});

test("stale and locally expired plans expose historical context without an actionable amount", async ({page}) => {
  await mockPlanning(page,{initial:"saved"});
  await signInPlanning(page);
  await expect(page.getByTestId("private-spending-room")).toContainText("200,00");
  await page.clock.runFor(6*60*1000);
  await expect(page.getByTestId("private-spending-room")).toContainText("Review needed");
  await expect(page.getByRole("button",{name:"Confirm savings reservation"})).toBeDisabled();
});

test("source review failure preserves access to existing reservation release", async ({page}) => {
  const calls = await mockPlanning(page,{initial:"reserved",failContext:true});
  await signInPlanning(page);
  await expect(page.locator(".reservation-list")).toContainText("Reserved");
  await expect(page.getByRole("main")).toContainText("Source review is unavailable");
  await expect(page.getByRole("button",{name:"Confirm savings reservation"})).toBeDisabled();
  await page.getByRole("button",{name:/Release .* reservation/}).click();
  await expect(page.locator(".reservation-list")).toContainText("Released");
  expect(calls.releases).toHaveLength(1);
});

test("foreign source balances are never relabeled as EUR or accepted as EUR planning input", async ({page}) => {
  const calls = await mockPlanning(page,{foreignCurrency:true});
  await signInPlanning(page);
  await expect(page.getByRole("main")).toContainText("Outside EUR plan");
  await expect(page.getByRole("main")).toContainText("no conversion is available");
  await expect(page.locator(".review-account-heading")).not.toContainText("800,00");
  await expect(page.getByRole("button",{name:"Calculate and save reviewed plan"})).toBeDisabled();
  expect(calls.creates).toHaveLength(0);
});

for (const failContext of [true,false]) test(`unavailable saved source review preserves release with context ${failContext ? "blocked" : "available"}`, async ({page}) => {
  const calls = await mockPlanning(page,{initial:"reserved",failContext,failReview:true});
  await signInPlanning(page);
  await expect(page.getByRole("main")).toContainText("Source review is unavailable");
  await expect(page.getByTestId("private-spending-room")).toContainText("Review needed");
  await expect(page.getByRole("button",{name:"Confirm savings reservation"})).toHaveCount(0);
  await expect(page.getByRole("heading",{name:"Choose what to keep flexible"})).toHaveCount(0);
  await expect(page.locator(".reservation-list")).toContainText("Reserved");
  if (failContext) {
    await mkdir(".impeccable/review",{recursive:true});
    for (const [width,theme,name] of [[1440,"light","source-blocked-desktop"],[320,"dark","source-blocked-mobile"]] as const) {
      await page.setViewportSize({width,height:1000}); await page.emulateMedia({colorScheme:theme});
      await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
  }
  await page.getByRole("button",{name:/Release .* reservation/}).click();
  await expect(page.locator(".reservation-list")).toContainText("Released");
  expect(calls.releases).toHaveLength(1);
});

test("private plan layout preserves the established light/dark design at desktop mobile and enlarged text", async ({page}) => {
  await mockPlanning(page,{initial:"saved"});
  await signInPlanning(page);
  await expect(page.getByRole("heading",{name:"Your reviewed spending room"})).toBeVisible();
  await mkdir(".impeccable/review",{recursive:true});
  const capture = async (width: number, height: number, theme:"light"|"dark", name: string) => {
    await page.setViewportSize({width,height}); await page.emulateMedia({colorScheme:theme});
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:`.impeccable/review/${name}.png`,fullPage:true,animations:"disabled"});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  };
  await capture(1440,1100,"light","desktop");
  await capture(320,900,"dark","mobile-summary");
  await page.getByRole("button",{name:"Review a replacement plan"}).click();
  await expect(page.getByRole("heading",{name:"Review your next 30 days"})).toBeVisible();
  await capture(1440,1100,"light","desktop-review");
  await capture(320,900,"dark","mobile");
  await page.evaluate(() => {document.documentElement.style.fontSize="200%";});
  await capture(320,900,"light","mobile-zoom");
});
