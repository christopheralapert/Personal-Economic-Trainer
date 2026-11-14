import {test,expect} from "./demo-support";

for(const width of [360,1280]) {
  test(`skip link focuses the loaded demo at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    await page.goto("/demo?dataset=organizer1");
    await expect(page.locator("#home-question")).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link",{name:"Skip to content",exact:true})).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator("#main")).toBeFocused();
    await expect(page.locator("main")).toHaveCount(1);
    await page.keyboard.press("Tab");
    expect(await page.locator("#main").evaluate(main=>main.contains(document.activeElement))).toBe(true);
  });

  for(const retainFocus of [true,false]) test(`skip link works before hydration at ${width}px and ${retainFocus ? "retains main focus" : "respects a later focus choice"}`,async({page})=>{
    await page.setViewportSize({width,height:900});
    let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    // Hold scripts, not HTML/CSS: exercise the actual native link during loading.
    await page.route("**/_next/static/**/*.js",async route=>{await gate;await route.continue();});
    try {
      await page.goto("/demo?dataset=organizer1",{waitUntil:"commit"});
      await expect(page.getByRole("status")).toBeVisible();
      await expect(page.locator("#home-question")).toHaveCount(0);
      await page.keyboard.press("Tab");
      const skip=page.getByRole("link",{name:"Skip to content",exact:true});
      await expect(skip).toBeFocused();
      await page.keyboard.press("Enter");
      const main=page.locator("#main");
      await expect(main).toBeFocused();
      if(!retainFocus){await page.keyboard.press("Shift+Tab");await expect(skip).toBeFocused();}
      release();
      await expect(page.locator("#home-question")).toBeVisible();
      await expect(retainFocus ? main : skip).toBeFocused();
      await expect(page.locator("main")).toHaveCount(1);
    } finally {release();}
  });
}
