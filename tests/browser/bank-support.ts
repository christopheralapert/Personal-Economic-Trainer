import type {Page} from "@playwright/test";
import type {components} from "../../packages/contracts/api";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";

type Schema = components["schemas"];
const instant = "2026-11-04T00:00:00+02:00";
export const banks: Schema["BankCapabilitiesV1"][] = (["s-bank-demo","north-demo"] as const).map((id,index) => ({
  id,name:index ? "North demo bank (fictional)" : "S-Bank-shaped simulator",mode:"synthetic",
  notice:"Entirely synthetic simulator. No connection to S-Bank, PSD2 sandbox or live customer accounts.",
  currencies:["EUR"],account_types:["current"],balance_kind:index ? "booked" : "available",pending_reflection:index ? "excluded" : "included",
  supports_pending:true,maximum_page_size:100,history_from:"2026-08-01",minimum_refresh_seconds:30,consent_seconds:index ? 1800 : 3600,timeout_seconds:5,timezone:"Europe/Helsinki",payments_supported:false,
}));

/** UI transport fixtures; financial publication itself is verified in real SQL tests. */
export async function mockBanks(page: Page, options: {failStartOnce?:boolean; failCompleteOnce?:boolean; published?:boolean; sourceError?:boolean; unavailable?:boolean} = {}) {
  await page.clock.install({time:new Date(instant)});
  let authenticated = false, lost = false;
  const connections: Schema["BankConnectionV1"][] = [];
  const calls: {path:string;body:Record<string,unknown>}[] = [];
  const commands = new Map<string,unknown>();
  const key = (body:Record<string,unknown>) => String(body.key);
  const publish = () => connections.forEach(connection => {connection.sync_health="fresh";connection.last_success_at=instant;connection.source_observed_at=instant;});
  const create = (id: typeof banks[number]["id"]) => {
    const bank=banks.find(value=>value.id===id)!;
    const connection: Schema["BankConnectionV1"]={id:`00000000-0000-0000-0000-${String(connections.length+1).padStart(12,"0")}`,institution_id:id,name:bank.name,mode:"synthetic",consent_state:"authorizing",generation:1,account_references:[],expires_at:null,sync_health:"never_synced",last_success_at:null,last_error_code:null,synthetic_fault:"healthy",refresh_job_id:null,last_attempt_at:null,source_observed_at:null,staged_at:null};
    connections.push(connection); return connection;
  };
  if (options.published) {
    const connection=create("s-bank-demo");connection.consent_state="active";connection.account_references=["source-account"];connection.expires_at="2026-11-04T01:00:00+02:00";publish();
    if (options.sourceError) {connection.sync_health="error";connection.last_error_code="BANK_UNAVAILABLE";}
  }
  await page.route("**/api/v1/**", async route => {
    const request=route.request(), path=new URL(request.url()).pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    if (path==="auth/demo") {authenticated=true;return respond(fixture.session);}
    if (!authenticated) return respond({error:{code:"UNAUTHENTICATED",message:"Sign in to continue."}},401);
    if (path==="auth/session") return respond(fixture.session);
    if (request.headers()["x-moneylens-session-id"]!==fixture.session.session_id) throw new Error("Bank UI must bind its expected session.");
    if (path==="banks") return respond(banks);
    if (path==="bank-connections" && request.method()==="GET") return options.unavailable ? respond({error:{code:"SERVICE_UNAVAILABLE",message:"Connection status is unavailable. Try again."}},503) : respond(connections);
    if (path==="accounts/sources") return respond(connections.filter(connection=>connection.last_success_at).map(connection=>({id:`account-${connection.id}`,name:"Everyday synthetic account",currency:"EUR",included:true,account_type:"current",source:{account_id:`account-${connection.id}`,connection_id:connection.id,institution_id:connection.institution_id,mode:"synthetic",consent_state:connection.consent_state,granted:connection.consent_state==="active",sync_health:connection.sync_health,observed_at:instant,history_from:"2026-08-01",history_to_exclusive:"2026-11-05",last_success_at:connection.last_success_at,last_error_code:connection.last_error_code,source_version:"sim-ui-only",timezone:"Europe/Helsinki"}})));
    const body=request.postDataJSON() as Record<string,unknown>;
    if (request.headers()["x-csrf-token"]!==fixture.session.csrf_token) throw new Error("Bank writes must include CSRF.");
    calls.push({path,body});
    if (path==="bank-connections") {
      let result=commands.get(key(body));
      if (!result) {const connection=create(body.institution_id as typeof banks[number]["id"]);result={connection,authorization:{reference:connection.id,mode:"synthetic",expires_at:"2026-11-04T00:10:00+02:00",notice:banks[0].notice,available_accounts:[{reference:"source-account",canonical_reference:"synthetic:source-account",name:"Everyday synthetic account",currency:"EUR",account_type:"current"}]},state_token:"a".repeat(43)};commands.set(key(body),result);}
      if (options.failStartOnce && !lost) {lost=true;return route.abort("failed");}
      return respond(result);
    }
    const connection=connections.find(item=>path.includes(item.id));
    if (!connection) return respond({error:{code:"NOT_FOUND"}},404);
    if (path.endsWith("/complete")) {
      connection.consent_state=body.approved ? "active" : "denied";connection.account_references=body.account_references as string[];connection.expires_at=body.approved ? "2026-11-04T01:00:00+02:00" : null;
      if (options.failCompleteOnce && !lost) {lost=true;return route.abort("failed");}
      return respond(connection);
    }
    if (path.endsWith("/disconnect")) {connection.consent_state="revoked";return respond(connection);}
    if (path.endsWith("/refresh")) {connection.sync_health="syncing";connection.refresh_job_id="00000000-0000-0000-0000-000000000099";return respond({connection,job:{id:connection.refresh_job_id,type:"bank.fetch",state:"queued",attempts:0,max_attempts:5,available_at:instant,lease_until:null,finished_at:null,last_error_code:null},coalesced:false,financial_publication_complete:false});}
    return respond({error:{code:"NOT_FOUND"}},404);
  });
  return {calls,connections,publish};
}

export async function signInBanks(page:Page) {await page.goto("/banks");await page.getByRole("button",{name:"Continue as Aino"}).click();await page.getByRole("heading",{name:"Your banks, in one place."}).waitFor();}
