import {test,expect} from "@playwright/test";
const normal=process.env.MONEYLENS_NORMAL_ORIGIN!,isolated=process.env.MONEYLENS_CONFIG_TEST_ORIGIN!,api=process.env.MONEYLENS_CONFIG_TEST_API!;
test("same artifact: ordinary configuration exposes no test identity or login",async({page,request})=>{
 const response=await page.goto(normal+"/demo?dataset=organizer1");expect(response?.status()).toBe(200);
 await expect(page.locator("header")).toContainText("S-Pankki challenge demo");
 const build=response!.headers()["x-moneylens-build"];
 expect((await request.get(isolated+"/demo?dataset=organizer1")).headers()["x-moneylens-build"]).toBe(build);
 await page.goto(normal+"/coach");await expect(page.locator("[data-coach-answer],[data-coach-ledger-row]")).toHaveCount(0);
 await expect(page.getByRole("heading",{level:1})).toHaveText("See your own money");
 await expect(page.locator(".private-sign-in")).toContainText(/sign in/i);
 await expect(page.getByRole("link",{name:"Connect your bank",exact:true})).toHaveCount(0);
 for(const route of["/rehearsal/authorize","/rehearsal/summary","/api/v1/auth/login","/api/v1/auth/session"]){const r=await request.get(normal+route);expect(r.status(),route).toBe(404);}
 expect((await request.post(normal+"/api/v1/auth/demo",{data:{profile:"aino"}})).status()).toBe(404);
 expect((await request.get(normal+"/api/v1/accounts")).status()).toBe(404);
 console.log(JSON.stringify({mode:"ordinary",build,testIdentity:false,privateWorkspace:"signed out; real OIDC not configured",demo:200}));
});
test("test configuration: no workspace before verification, bad signature denied, good identity creates one",async({page,request})=>{
 const members=async()=>(await(await request.get(api+"/rehearsal/summary")).json()).members;
 expect(await members()).toBe(0);
 expect((await request.get(isolated+"/api/v1/auth/callback?code=invalid&state=invalid")).status()).toBe(400);expect(await members()).toBe(0);
 await page.goto(isolated+"/banks");await page.getByRole("link",{name:"Connect your bank",exact:true}).click();expect(await members()).toBe(0);
 const denied=page.waitForResponse(r=>new URL(r.url()).pathname==="/api/v1/auth/callback");await page.getByRole("link",{name:"invalid-signature",exact:true}).click();expect((await denied).status()).toBe(401);expect(await members()).toBe(0);
 await page.goto(isolated+"/banks");await page.getByRole("link",{name:"Connect your bank",exact:true}).click();expect(await members()).toBe(0);
 await page.getByRole("link",{name:"configuration-review",exact:true}).click();await expect(page.getByRole("link",{name:"Learn",exact:true})).toBeVisible();expect(await members()).toBe(1);
 expect((await request.get(isolated+"/api/v1/auth/session")).status()).toBe(401);
 await page.goto(isolated+"/api/v1/auth/login");await page.getByRole("link",{name:"configuration-review",exact:true}).click();await expect(page.getByRole("link",{name:"Learn",exact:true})).toBeVisible();expect(await members()).toBe(1);
 console.log(JSON.stringify({mode:"isolated test OIDC",beforeVerified:0,afterBadSignature:0,afterVerified:1,afterRepeat:1,build:(await request.get(isolated+"/banks")).headers()["x-moneylens-build"]}));
});
