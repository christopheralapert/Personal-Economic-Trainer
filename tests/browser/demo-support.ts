import {test as base,expect} from "@playwright/test";

type DemoTraffic={chat:Record<string,unknown>[];privatePaths:string[]};

/** Use the real chat stream and rules; never contact a bank, identity provider or model. */
export const test=base.extend<{demoTraffic:DemoTraffic}>({
  demoTraffic:[async({page,baseURL},use)=>{
    const traffic:DemoTraffic={chat:[],privatePaths:[]},unexpected:string[]=[];
    await page.route("**/*",async route=>{
      const request=route.request(),url=new URL(request.url());
      if(url.origin!==new URL(baseURL!).origin){unexpected.push(url.origin);return route.abort();}
      if(url.pathname==="/api/chat"){
        const body=request.postDataJSON();traffic.chat.push(body);
        // Even a persisted online preference must not enable a paid test request.
        const response=await route.fetch({postData:{...body,privacy:true}});
        expect(response.status()).toBe(200);
        expect(response.headers()["x-money-coach-source"]).toBe("rule");
        expect(response.headers()["x-money-coach-evaluation"]).toBe("privacy_rule");
        expect(response.headers()["x-money-coach-provider"]).toBeUndefined();
        return route.fulfill({response});
      }
      if(url.pathname.startsWith("/api/v1/")){
        traffic.privatePaths.push(url.pathname);
        if(url.pathname!=="/api/v1/auth/session")unexpected.push(url.pathname);
        return route.fulfill({status:401,json:{error:{code:"UNAUTHENTICATED"}}});
      }
      if(url.pathname==="/api/demo/banks")return route.fulfill({json:[]});
      if(url.pathname==="/api/voice/capabilities")return route.fulfill({json:{enabled:false}});
      if(url.pathname.startsWith("/api/")){unexpected.push(url.pathname);return route.abort();}
      return route.continue();
    });
    await page.emulateMedia({reducedMotion:"reduce"});
    await use(traffic);
    expect(unexpected,"Demo tests must stay on the synthetic test transport").toEqual([]);
  },{auto:true}],
});
export {expect};
