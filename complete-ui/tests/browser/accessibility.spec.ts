import {checkBasis} from "../basis";
import {test,expect,type Page} from "@playwright/test";
import {en,fi,et} from "../../src/i18n/dictionaries";
import {percent} from "../../src/lib/format";

async function audit(page:Page,scope:string) {
  await page.addScriptTag({path:require.resolve("axe-core")});
  const violations=await page.evaluate(async()=>{
    const {axe}=window as unknown as {axe:typeof import("axe-core")};
    const result=await axe.run(document,{runOnly:{type:"tag",values:["wcag2a","wcag2aa","wcag21aa"]}});
    return result.violations.map(({id,nodes})=>({id,targets:nodes.map(node=>node.target)}));
  });
  expect(violations,scope).toEqual([]);
}

test("accessible controls, chart alternatives and WCAG checks across themes and locales",async({page})=>{
  test.setTimeout(120000);
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:"reduce"});
  for(const colorScheme of ["light","dark"] as const) {
    await page.emulateMedia({colorScheme});await page.goto("/");
    await expect(page.getByRole("tab",{name:en.overview,exact:true})).toHaveAttribute("aria-selected","true");
    await audit(page,`${colorScheme} overview`);
    await page.getByRole("tab",{name:en.whatif,exact:true}).click();
    const dining=page.getByRole("slider",{name:`${en.reduce} ${en.dining}`,exact:true});
    await expect(dining).toHaveAttribute("aria-valuetext",percent(20));
    await dining.focus();await page.keyboard.press("ArrowRight");
    await expect(dining).toHaveAttribute("aria-valuetext",percent(21));
    await audit(page,`${colorScheme} simulator`);
    await page.getByRole("button",{name:en.settings,exact:true}).click();
    await audit(page,`${colorScheme} settings`);
    let current:typeof fi=en;
    for(const copy of [fi,et,en]) {
      await page.getByLabel(copy===fi ? current.finnish : copy===et ? current.estonian : current.english,{exact:true}).check();
      await expect(page.getByRole("slider",{name:copy.target,exact:true})).toHaveAttribute("aria-valuetext",percent(10));
      current=copy;
    }
    await page.getByRole("button",{name:en.overview,exact:true}).click();
    await page.getByRole("tab",{name:en.learn,exact:true}).click();
    await audit(page,`${colorScheme} learn`);
    await page.getByRole("tab",{name:en.coach,exact:true}).click();
    for(const question of [en.qDonut,en.qBaskets,en.qWhatif]) {
      await page.getByRole("textbox",{name:en.questionLabel,exact:true}).fill(question);
      await page.getByRole("button",{name:en.send,exact:true}).click();
      await checkBasis(page,page.locator("article").last());
    }
    await audit(page,`${colorScheme} generated chat`);
    await page.goto("/kit");
    await expect(page.locator("[data-component=showDonut] svg.recharts-surface")).toBeVisible();
    await audit(page,`${colorScheme} component kit`);
    const chart=page.locator("[data-component=showDonut]");
    await expect(chart.getByRole("table")).toHaveCount(1);
    const legend=chart.getByRole("button").first();
    await legend.focus();await page.keyboard.press("Space");
    await expect(chart.locator("button[aria-pressed]").first()).toHaveAttribute("aria-pressed","true");await page.getByRole("dialog").getByRole("button",{name:en.done,exact:true}).click();
    await page.getByRole("button",{name:en.filter,exact:true}).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await audit(page,`${colorScheme} filter sheet`);
    await page.getByRole("button",{name:en.done,exact:true}).click();
  }
});
