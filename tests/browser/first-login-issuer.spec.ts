import {test,expect,type Page} from "@playwright/test";
import {mkdir} from "node:fs/promises";

const api=process.env.MONEYLENS_FIRST_LOGIN_TEST_API;
test.skip(!api,"Run through test_first_login_browser.py with an isolated database and signed test issuer.");
async function issuer(page:Page,identity:"unknown"|"invited"|"returning"){
 if(!api||new URL(api).hostname!=="127.0.0.1")throw new Error("Only an isolated loopback test API is allowed");
 await page.route("https://**",route=>route.abort());
 await page.route("**/api/v1/**",async route=>{
  const url=new URL(route.request().url());
  // Never follow redirects in this transport: the browser must receive the
  // binding/session cookies and traverse the intercepted test issuer itself.
  const response=await route.fetch({url:`${api}${url.pathname.replace('/api/v1/','/v1/')}${url.search}`,maxRedirects:0});
  if(url.pathname==="/api/v1/auth/login"){
   // Playwright does not reroute every hop in a browser redirect chain. Keep
   // the actual binding cookie, but make the issuer hop an explicit test link
   // so it cannot escape interception and contact an external identity host.
   expect(response.status()).toBe(303);
   const headers=response.headers(),target=headers.location;
   expect(new URL(target).origin).toBe("https://identity.example");
   delete headers.location;delete headers["content-security-policy"];delete headers["content-length"];
   headers["content-type"]="text/html";
   return route.fulfill({status:200,headers,body:`<a href="${target.replaceAll('&','&amp;')}">Open test issuer</a>`});
  }
  await route.fulfill({response});
 });
 await page.route("https://identity.example/authorize**",async route=>{
  const url=new URL(route.request().url()),state=url.searchParams.get("state")!;
  const back=new URL("/api/v1/auth/callback",process.env.MONEYLENS_FIRST_LOGIN_BROWSER_ORIGIN!);back.search=new URLSearchParams({code:`${identity}:${state}`,state,iss:"https://identity.example"}).toString();
  await route.fulfill({contentType:"text/html",body:`<p>Repository test issuer. No Auth0 or Google contacted.</p><a href="${back.href.replaceAll('&','&amp;')}">Continue with test identity</a>`});
 });
}
async function login(page:Page){await page.goto("/api/v1/auth/login");await page.getByRole("link",{name:"Open test issuer"}).click();await page.getByRole("link",{name:"Continue with test identity"}).click();}
async function capture(page:Page,name:string){await mkdir(".cache/first-login-review",{recursive:true});for(const mode of ["light","dark"] as const){await page.emulateMedia({colorScheme:mode});await page.screenshot({path:`.cache/first-login-review/${name}-${mode}.png`,animations:"disabled"});}expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}

test("verified unprovisioned identity has no session and reaches public demo",async({page,context})=>{
 await issuer(page,"unknown");await page.goto("/demo");await expect(page.locator("header")).toContainText("30.9.2026");
 await login(page);await expect(page).toHaveURL(/\/access$/);
 await expect(page.getByRole("heading",{name:"Your Money Coach access hasn’t been set up yet."})).toBeVisible();
 expect((await context.cookies()).filter(c=>c.name.includes("moneylens_session")||c.name.includes("moneylens_login"))).toEqual([]);
 await capture(page,"access");await page.setViewportSize({width:1440,height:900});await capture(page,"access-desktop");await page.setViewportSize({width:390,height:844});
 await page.getByRole("link",{name:"Sign in with another account",exact:true}).click();await page.getByRole("link",{name:"Open test issuer"}).click();await expect(page).toHaveURL(/identity\.example\/authorize.*prompt=login/);
 await page.goto("/access");await page.getByRole("link",{name:"Try the demo",exact:true}).click();await expect(page.locator("header")).toContainText("30.9.2026");
});
test("admin-invited identity receives a real test session and a first-bank entry",async({page,context})=>{
 await issuer(page,"invited");await login(page);await expect(page.locator("[data-first-bank]")).toBeVisible();
 expect((await context.cookies()).find(c=>c.name==="moneylens_session")?.httpOnly).toBe(true);await capture(page,"invited");
 await page.getByRole("link",{name:"Connect your bank",exact:true}).click();await expect(page.getByLabel("Find your bank")).toBeVisible();
 await page.getByRole("button",{name:"LHV",exact:true}).click();await page.getByRole("button",{name:"Continue to LHV",exact:true}).click();
 await expect(page.getByRole("link",{name:"Connect a demo bank",exact:true})).toHaveAttribute("href","/demo/banks");
 await expect(page.getByText(/Money Coach access does not grant bank-account approval/)).toBeVisible();await capture(page,"provider-denied");
});
test("returning identity with a mocked existing bank gets the normal dashboard",async({page})=>{
 await issuer(page,"returning");await login(page);await expect(page.locator('[data-overview-block="hero"]')).toBeVisible();await expect(page.locator("[data-first-bank]")).toHaveCount(0);
 await expect(page.getByRole("navigation",{name:"Main navigation"}).getByRole("link")).toHaveCount(4);await capture(page,"returning");
 await page.goto("/banks");await expect(page.getByRole("button",{name:"Add another bank",exact:true})).toBeVisible();
});
