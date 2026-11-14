import {test,expect} from "@playwright/test";
import {mkdir} from "node:fs/promises";

// Configuration fixtures belong to the isolated servers, never the user's .env.
test.beforeEach(async({page},info)=>{
  test.skip(!info.project.name.startsWith("legal-"),"Run npm run test:web:legal for isolated legal configuration fixtures.");
  await page.context().clearCookies();
});

for(const [path,title,heading] of [["privacy","Privacy Policy | MoneyLens","Privacy, explained."],["terms","Terms of Use | MoneyLens","Terms of use."]] as const) {
  test(`${path} is anonymous, no-store and shows only configured public contact fields`,async({page,context},info)=>{
    const configured=info.project.name==="legal-configured";
    const apiCalls:string[]=[],scripts=new Set<string>();
    page.on("request",req=>{if(new URL(req.url()).pathname.startsWith("/api/"))apiCalls.push(req.url());if(req.resourceType()==="script")scripts.add(req.url());});
    const response=await page.goto(`/${path}`);
    expect(response?.status()).toBe(200);expect(response?.headers()["cache-control"]).toContain("no-store");
    await expect(page).toHaveTitle(title);await expect(page.getByRole("heading",{level:1,name:heading})).toBeVisible();
    await expect(page.getByRole("navigation",{name:"Legal pages"}).getByRole("link",{name:path==="privacy"?"Privacy":"Terms",exact:true})).toHaveAttribute("aria-current","page");
    const operator=page.getByRole("region",{name:"Who operates this prototype?"});
    if(configured){
      await expect(page.getByText("Operator details need configuration.",{exact:true})).toHaveCount(0);
      await expect(operator).toContainText("Automation fixture (not a real operator)");
      await expect(operator).toContainText("Automation fixture location");
      await expect(operator.getByRole("link",{name:"legal-fixture@example.invalid"})).toHaveAttribute("href","mailto:legal-fixture@example.invalid");
    }else{
      await expect(page.getByText("Operator details need configuration.",{exact:true})).toBeVisible();
      await expect(operator.getByText("Not yet configured",{exact:true})).toHaveCount(3);
      await expect(operator.locator('a[href^="mailto:"]')).toHaveCount(0);
    }
    await expect(page.getByText(/does not automatically (delete|erase)/).first()).toBeVisible();
    expect(apiCalls).toEqual([]);expect(await context.cookies()).toEqual([]);
    expect(await response!.text()).not.toContain("PRIVATE_LEGAL_TEST_MARKER_DO_NOT_DISCLOSE");
    for(const url of scripts){
      const body=await (await context.request.get(url)).text();
      expect(body).not.toContain("PRIVATE_LEGAL_TEST_MARKER_DO_NOT_DISCLOSE");
      expect(body).not.toContain("MONEYLENS_LEGAL_OPERATOR_NAME");
      expect(body).not.toContain("MONEYLENS_ENABLE_BANKING_PRIVATE_KEY_PEM");
    }
    await page.getByRole("complementary",{name:"On this page"}).getByRole("link",{name:path==="privacy"?"Retention and disconnection":"Privacy and retention"}).click();
    await expect(page).toHaveURL(new RegExp(path==="privacy"?"#retention$":"#privacy$"));
    await mkdir(".impeccable/review",{recursive:true});
    if(!configured)for(const [width,theme] of [[390,"light"],[390,"dark"],[1440,"light"],[1440,"dark"]] as const){
      await page.setViewportSize({width,height:844});await page.emulateMedia({colorScheme:theme});await page.evaluate(()=>scrollTo(0,0));
      await page.screenshot({path:`.impeccable/review/legal-${path}-${width}-${theme}.png`,fullPage:true,animations:"disabled"});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await page.setViewportSize({width:390,height:844});await page.evaluate(()=>{document.documentElement.style.fontSize="130%";});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}

test("public and private footers expose legal pages without changing bank authentication",async({page})=>{
  await page.goto("/");
  for(const label of ["Privacy","Terms"]){await expect(page.getByRole("navigation",{name:"Legal information"}).getByRole("link",{name:label,exact:true})).toHaveAttribute("href",`/${label.toLowerCase()}`);}
  await page.goto("/banks");
  await expect(page.getByRole("heading",{name:"Your plan, your profile."})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Your banks, securely connected."})).toHaveCount(0);
  await page.getByRole("navigation",{name:"Legal information"}).getByRole("link",{name:"Privacy",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Privacy, explained."})).toBeVisible();
});
