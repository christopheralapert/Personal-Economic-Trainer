import type {Page} from "@playwright/test";
import fixture from "../../fixtures/synthetic/population-ui.v1.json";

export {fixture as populationFixture};
type Scenario = keyof typeof fixture.scenarios;

export async function mockPopulation(page:Page, options:{scenario?:Scenario; unavailableMetadata?:boolean; failComparison?:boolean; delayed?:boolean}={}) {
  await page.clock.install({time:new Date(fixture.clock)});
  let authenticated=false;
  const calls:Record<string,unknown>[]=[];
  let release:()=>void=()=>{};
  const held=options.delayed ? new Promise<void>(resolve=>{release=resolve;}) : Promise.resolve();
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(), path=new URL(request.url()).pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/demo") {authenticated=true;return respond(fixture.session);}
    if(!authenticated) return respond({error:{code:"UNAUTHENTICATED",message:"Sign in to continue."}},401);
    if(path==="auth/session") return respond(fixture.session);
    if(request.headers()["x-moneylens-session-id"]!==fixture.session.session_id) throw new Error("Expected the verified session hint.");
    if(request.method()==="POST" && request.headers()["x-csrf-token"]!==fixture.session.csrf_token) throw new Error("Expected session-bound CSRF.");
    if(path==="auth/logout") {authenticated=false;return route.fulfill({status:204});}
    if(path==="public/benchmarks/cohorts") return respond(options.unavailableMetadata ? {available:false,catalog:null,reason:"VERIFIED_COHORTS_UNAVAILABLE"} : fixture.cohorts);
    if(path==="public/benchmarks/category-crosswalk") return respond(fixture.crosswalk);
    if(path==="accounts/sources") return respond(fixture.accounts);
    if(path==="benchmarks/comparison") {
      const body=request.postDataJSON();calls.push(body);
      await held;
      if(options.failComparison) return respond({error:{code:"BANK_ACCOUNT_ACCESS_REQUIRED",message:"Renew source access."}},409);
      const key=(value:Record<string,unknown>)=>JSON.stringify(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)));
      const example=options.scenario ? fixture.scenarios[options.scenario] : Object.values(fixture.scenarios).find(example=>key(example.request)===key(body));
      if(!example) throw new Error("No real-engine UI fixture for the submitted comparison.");
      return respond(example.result);
    }
    return respond({error:{code:"NOT_FOUND"}},404);
  });
  return {calls,release:()=>release()};
}

export async function signInPopulation(page:Page) {
  await page.goto("/compare");await page.getByRole("button",{name:"Continue as Aino"}).click();
}

export async function choosePopulation(page:Page, options:{confirm?:boolean;categories?:string[];household?:string}={}) {
  await page.getByRole("combobox",{name:"Household group",exact:true}).selectOption(options.household ?? "1");
  await page.getByLabel("First month",{exact:true}).fill("2026-10");
  await page.getByLabel("Last month (included)",{exact:true}).fill("2026-10");
  for(const code of options.categories ?? ["07322","01"]) {
    const target=fixture.crosswalk.policy.targets.find(item=>item.code===code)!;
    await page.getByRole("checkbox",{name:target.label,exact:true}).check();
  }
  if(options.confirm!==false) {
    await page.getByLabel(/I confirm these accounts cover/).check();
    await page.getByLabel(/I accept that fewer than twelve months/).check();
    await page.getByLabel(/I accept the 2022 price reference/).check();
  }
}
