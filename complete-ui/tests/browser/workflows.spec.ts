import {test,expect} from "@playwright/test";
import path from "node:path";
import {en,fi,et} from "../../src/i18n/dictionaries";

const captures=path.resolve(__dirname,"../../../../.impeccable/review/money-coach");

test("learning opens a scoped answer with one request and follow-ups match the answer in every locale",async({page})=>{
  let calls=0;page.on("request",request=>{if(request.method()==="POST" && request.url().endsWith("/api/chat")) calls++;});
  await page.setViewportSize({width:390,height:844});await page.goto("/");
  for(const copy of [en,fi,et]) {
    await page.getByRole("button",{name:en.settings,exact:true}).click();
    await page.getByLabel(copy===fi ? en.finnish : copy===et ? en.estonian : en.english,{exact:true}).check();
    await page.getByRole("button",{name:copy.overview,exact:true}).click();
    await page.getByRole("tab",{name:copy.learn,exact:true}).click();
    const before=calls;
    await page.getByRole("button",{name:new RegExp(copy.habit)}).click();
    const input=page.getByRole("textbox",{name:copy.questionLabel,exact:true});
    await expect(input).toHaveValue("");expect(calls).toBe(before+1);
    await expect(page.locator("article").last()).toContainText("50,00");
    const composer=page.locator("article").last();
    await expect(composer.getByRole("button",{name:copy.qFollowPercent,exact:true})).toBeVisible();
    await expect(composer.getByRole("button",{name:copy.qProfile,exact:true})).toBeVisible();
    expect(calls).toBe(before+1);
    await composer.getByRole("button",{name:copy.qFollowPercent,exact:true}).click();
    await expect(page.locator("article").last()).toContainText("75,00");
    expect(calls).toBe(before+2);
    await page.getByRole("button",{name:copy.settings,exact:true}).click();
    await page.getByLabel(copy.english,{exact:true}).check();
    await page.getByRole("button",{name:en.overview,exact:true}).click();
  }
});

test("goal steps support keyboard validation, exact amounts, back navigation and editing without persistence",async({page})=>{
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/");
  await page.getByRole("button",{name:en.settings,exact:true}).click();
  await page.getByRole("button",{name:en.goal,exact:true}).click();
  const form=page.locator("form"),name=form.getByLabel(en.goalName,{exact:true}),amount=form.getByLabel(en.goalAmount,{exact:true});
  await expect(name).toBeFocused();await name.press("Enter");await expect(form.getByRole("alert")).toHaveText(en.goalNameError);
  await expect(name).toHaveAttribute("aria-invalid","true");
  await name.fill("  Buffer & travel  ");await name.press("Enter");await expect(amount).toBeFocused();
  for(const invalid of ["0","1.001","90071992547409,92"]) {
    await amount.fill(invalid);await amount.press("Enter");await expect(form.getByRole("alert")).toHaveText(en.goalAmountError);
  }
  await amount.fill("1234,56");await amount.press("Enter");
  await expect(form.getByRole("heading",{name:en.goalReview,exact:true})).toBeFocused();
  await expect(form).toContainText(/1\s234,56/);
  for(const colorScheme of ["light","dark"] as const) {
    await page.emulateMedia({colorScheme});
    await page.addScriptTag({path:require.resolve("axe-core")});
    const violations=await page.evaluate(async()=>{
      const {axe}=window as unknown as {axe:typeof import("axe-core")};
      return (await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}})).violations.map(item=>item.id);
    });
    expect(violations).toEqual([]);
    await page.screenshot({path:`${captures}/goal-review-${colorScheme}.png`});
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});
  for(const width of [360,390,430,768]) {
    await page.setViewportSize({width,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.evaluate(()=>{document.documentElement.style.fontSize="";});await page.setViewportSize({width:390,height:844});
  await form.getByRole("button",{name:en.back,exact:true}).click();await expect(amount).toHaveValue("1234,56");
  await form.getByRole("button",{name:en.back,exact:true}).click();await expect(name).toHaveValue("Buffer & travel");
  await name.press("Enter");await amount.press("Enter");await form.getByRole("button",{name:en.saveGoal,exact:true}).click();
  await expect(page.getByText(/Buffer & travel · 1\s234,56/)).toBeVisible();
  await page.getByRole("button",{name:en.editGoal,exact:true}).click();await expect(name).toHaveValue("Buffer & travel");
  await name.fill("Rainy day");await name.press("Enter");await expect(amount).toHaveValue("1234,56");
  await amount.fill("100.29");await amount.press("Enter");await form.getByRole("button",{name:en.saveGoal,exact:true}).click();
  await expect(page.getByText(/Rainy day · 100,29/)).toBeVisible();
  await page.reload();await page.getByRole("button",{name:en.settings,exact:true}).click();
  await expect(page.getByRole("button",{name:en.goal,exact:true})).toBeVisible();await expect(page.getByText("Rainy day",{exact:false})).toHaveCount(0);
});

test("stopping a held chat request permits a new answer and ignores late completion",async({page})=>{
  let release!:()=>void,arrived!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),firstRequest=new Promise<void>(resolve=>{arrived=resolve;});
  let calls=0;
  await page.route("**/api/chat",async route=>{
    if(++calls===1){arrived();await held;await route.abort("aborted").catch(()=>{});}
    else await route.continue();
  });
  try {
    await page.goto("/");await page.getByRole("tab",{name:en.coach,exact:true}).click();
    const input=page.getByRole("textbox",{name:en.questionLabel,exact:true}),send=page.getByRole("button",{name:en.send,exact:true});
    await input.fill(en.qTaxi);
    // Two submissions in the same event batch exercise the synchronous guard.
    await input.evaluate(node=>{const form=node.closest("form")!;form.requestSubmit();form.requestSubmit();});await firstRequest;
    await page.getByRole("button",{name:en.stop,exact:true}).click();await expect(input).toBeEnabled();
    await input.fill(en.qWhatif);await send.click();await expect(page.locator("article").last()).toContainText("50,00");
    release();await page.unroute("**/api/chat");
    await expect(page.locator("article")).toHaveCount(3);await expect(page.locator("article").last()).not.toContainText("40,00");
    expect(calls).toBe(2);
    await page.getByRole("button",{name:en.clear,exact:true}).click();await expect(page.locator("article")).toHaveCount(0);
    await input.fill(en.qTaxi);await send.click();await expect(page.locator("article").last()).toContainText("40,00");
  } finally {release();}
});


test("follow-ups retain edited sliders online and offline, then clear their context",async({page,context})=>{
  const requests:Record<string,unknown>[]=[];
  page.on("request",r=>{if(r.method()==="POST" && r.url().endsWith("/api/chat")) requests.push(r.postDataJSON());});
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({reducedMotion:"reduce"});await page.goto("/?question="+encodeURIComponent(en.qWhatif));
  const input=page.getByRole("textbox",{name:en.questionLabel,exact:true});
  await page.getByRole("button",{name:en.send,exact:true}).click();
  const result=page.locator("article").last();await expect(result).toContainText("50,00");
  await result.getByRole("slider").focus();await result.getByRole("slider").press("End");
  await expect(result).toContainText("250,00");
  await input.fill("And coffee?");await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText("16,50");
  expect(requests.at(-1)?.context).toEqual({tool:"showWhatIf",input:{period:{start:"2026-10-01",end:"2026-11-01"},category:"dining",pct:100}});
  expect((requests.at(-1)?.messages as unknown[])).toHaveLength(1);
  for(const colorScheme of ["light","dark"] as const) {await page.emulateMedia({colorScheme});await page.screenshot({path:`${captures}/follow-up-${colorScheme}.png`});}
  await context.setOffline(true);
  await input.fill("And at 30%?");await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText("4,95");
  await page.getByRole("button",{name:en.clear,exact:true}).click();
  await input.fill("And at 30%?");await page.getByRole("button",{name:en.send,exact:true}).click();
  await expect(page.locator("article").last()).toContainText(en.followupHelp);
  await context.setOffline(false);
});
