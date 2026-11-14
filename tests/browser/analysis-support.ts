import type {Page} from "@playwright/test";
import type {components} from "../../packages/contracts/api";
import demo from "../../fixtures/synthetic/demo.v1.json";
import planning from "../../fixtures/synthetic/planning-ui.v1.json";

type Schema=components["schemas"];
export type AnalysisCall=Schema["SpendingToolV1"] | Schema["LedgerSearchToolV1"];
type Query=Schema["SpendingArgumentsV1"];
type Failure="source" | "version" | "service";
const dataVersion=7;
const nextCursor="ui-only-analysis-next-25";

/** Distinct authored copies retain the public fixture's amounts and boundaries.
 * Thirty-two consumption rows exercise an actual 25-row page, not a short
 * artificial page. SQL aggregation/authorization is tested independently. */
export const analysisRows:Schema["LedgerRowV1"][]=Array.from({length:4},(_,copy)=>demo.profiles[0].transactions.map((transaction,index)=>({
  id:`00000000-0000-0000-0001-${String(copy*100+index+1).padStart(12,"0")}`,
  account_id:transaction.account_id,amount_minor:transaction.amount_minor,currency:transaction.currency,
  booked_on:transaction.booked_on,status:transaction.status,merchant:transaction.merchant,
  category:transaction.category,basket:transaction.basket,economic_flow:transaction.economic_flow,
}))).flat();

const consumption=(row:Schema["LedgerRowV1"])=>
  row.economic_flow==="expense" && row.amount_minor<=0 || row.economic_flow==="refund" && row.amount_minor>=0;

function selected(args:Query) {
  return analysisRows.filter(row=>row.status==="booked" && row.currency===(args.currency ?? "EUR") &&
    row.booked_on>=args.start && row.booked_on<args.end_exclusive &&
    (!args.account_ids || args.account_ids.includes(row.account_id)) &&
    (args.category==null || row.category===args.category) &&
    (args.merchant==null || row.merchant.toLowerCase().includes(args.merchant.toLowerCase())))
    .sort((a,b)=>b.booked_on.localeCompare(a.booked_on) || b.id.localeCompare(a.id));
}

function scope(args:Query,incomplete=false):Schema["LedgerScopeV1"] {
  const accountIds=demo.profiles[0].accounts.map(account=>account.id).sort();
  return {data_mode:"synthetic",account_ids:accountIds,currency:args.currency ?? "EUR",start:args.start,end_exclusive:args.end_exclusive,
    permission_version:1,data_version:dataVersion,plan_version:3,scope_kind:"included_accounts",whole_finances_confirmed:false,
    dataset_coverage:incomplete ? "unverified" : "covered_synthetic_snapshot",unverified_account_ids:incomplete ? accountIds : [],
    sources:incomplete ? [] : demo.profiles[0].accounts.map((account,index)=>({account_id:account.id,
      connection_id:`00000000-0000-0000-0002-${String(index+1).padStart(12,"0")}`,institution_id:account.institution_id,
      mode:"synthetic",consent_state:"active",granted:true,sync_health:"fresh",observed_at:demo.profiles[0].as_of,
      history_from:"2026-08-01",history_to_exclusive:"2026-11-05",last_success_at:demo.profiles[0].as_of,
      last_error_code:null,source_version:"analysis-ui-only.v1",timezone:"Europe/Helsinki"}))};
}

export function analysisTotals(args:Query,incomplete=false):Schema["SpendingTotalsV1"] {
  const rows=selected(args),eligible=rows.filter(consumption);
  const aggregate=(records:Schema["LedgerRowV1"][])=>{
    const gross_minor=records.filter(row=>row.economic_flow==="expense").reduce((sum,row)=>sum-row.amount_minor,0);
    const refunds_minor=records.filter(row=>row.economic_flow==="refund").reduce((sum,row)=>sum+row.amount_minor,0);
    return {gross_minor,refunds_minor,net_minor:gross_minor-refunds_minor,transaction_count:records.length};
  };
  const groups=(field:"category"|"merchant"):Schema["SpendingGroupV1"][]=>{
    const grouped=new Map<string,Schema["LedgerRowV1"][]>();
    for(const row of eligible) {
      const key=field==="category" ? `${row.category}\u0000${row.basket}` : row.merchant;
      grouped.set(key,[...(grouped.get(key) ?? []),row]);
    }
    return [...grouped.values()].map(records=>({label:records[0][field],basket:field==="category" ? records[0].basket : null,...aggregate(records)}))
      .sort((a,b)=>b.net_minor-a.net_minor || a.label.localeCompare(b.label));
  };
  const {transaction_count:_,...amounts}=aggregate(eligible);
  const evidenceScope=scope(args,incomplete);
  return {scope:evidenceScope,...amounts,expense_count:eligible.filter(row=>row.economic_flow==="expense").length,
    refund_count:eligible.filter(row=>row.economic_flow==="refund").length,unresolved_flow_count:0,
    nonconsumption_count:rows.filter(row=>["income","internal_transfer","liability_settlement"].includes(row.economic_flow)).length,
    category_baskets:groups("category"),merchants:groups("merchant"),category_breakdown_truncated:false,merchant_breakdown_truncated:false,
    evidence_filters:{start:args.start,end_exclusive:args.end_exclusive,currency:args.currency ?? "EUR",account_ids:evidenceScope.account_ids,
      category:args.category ?? null,merchant:args.merchant ?? null,status:"booked",spending_only:true},
    evidence_transaction_ids:eligible.slice(0,5).map(row=>row.id),limitations:[
      "Observed booked records only. Source coverage applies to the named accounts and observations; whole-finance and household coverage are not established.",
      "Zero observed records do not establish zero spending when source coverage is partial or unverified.",
      "Refunds reduce spending in their booking period. Income, transfers and liability settlements are excluded.",
      "Currencies are queried separately. No exchange-rate conversion or current-balance inference is performed."]};
}

export async function mockAnalysis(page:Page,options:{incomplete?:boolean;delayed?:boolean;mismatchPage?:"version"|"source"}={}) {
  await page.clock.install({time:new Date(planning.clock)});
  let authenticated=false,delayed=options.delayed ?? false;
  let session:Schema["SessionView"]=structuredClone(planning.session);
  let release:()=>void=()=>{};
  const gate=options.delayed ? new Promise<void>(resolve=>{release=resolve;}) : Promise.resolve();
  const state={calls:[] as AnalysisCall[],failNext:null as Failure | null,
    release:()=>release(),switchProfile:()=>{session={...session,display_name:"Synthetic Mika",
      session_id:"00000000-0000-0000-0000-000000000067",owner:{...session.owner,user_id:"00000000-0000-0000-0000-000000000068"}};}};
  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    if(path==="auth/demo") {authenticated=true;return respond(session);}
    if(!authenticated) return respond({error:{code:"UNAUTHENTICATED",message:"Sign in to continue."}},401);
    if(path==="auth/session") return respond(session);
    if(request.headers()["x-moneylens-session-id"]!==session.session_id) throw new Error("Analysis must bind the verified session.");
    if(request.method()==="POST" && request.headers()["x-csrf-token"]!==session.csrf_token) throw new Error("Analysis POSTs need session-bound CSRF.");
    if(path==="auth/logout") {authenticated=false;return route.fulfill({status:204});}
    if(path!=="analysis/tools/execute") return respond({error:{code:"NOT_FOUND"}},404);
    const call=request.postDataJSON() as AnalysisCall;
    state.calls.push(call);
    if(delayed) {delayed=false;await gate;}
    if(state.failNext) {
      const failure=state.failNext;state.failNext=null;
      const code=failure==="source" ? "BANK_ACCOUNT_ACCESS_REQUIRED" : failure==="version" ? "DATA_VERSION_CHANGED" : "SERVICE_UNAVAILABLE";
      return respond({error:{code,message:failure==="source" ? "A bank source needs attention." : failure==="version" ? "The data version changed. Inspect spending again." : "The service is unavailable. Try again."}},failure==="service" ? 503 : 409);
    }
    if(call.name==="spending_totals") return respond({name:call.name,result:analysisTotals(call.arguments,options.incomplete)} satisfies Schema["SpendingToolResultV1"]);
    if(call.name!=="ledger_transactions") throw new Error("Unexpected analysis command.");
    const args=call.arguments;
    if(args.expected_data_version!==dataVersion) return respond({error:{code:"DATA_VERSION_CHANGED",message:"Inspect the current totals again."}},409);
    const rows=selected(args).filter(consumption),offset=args.cursor===nextCursor ? 25 : 0,limit=args.limit ?? 25;
    const pageScope=scope(args,options.incomplete);
    if(options.mismatchPage==="version") pageScope.data_version+=1;
    if(options.mismatchPage==="source") pageScope.sources![0].source_version="inconsistent-ui-source";
    return respond({name:call.name,result:{scope:pageScope,rows:rows.slice(offset,offset+limit),
      next_cursor:rows.length>offset+limit ? nextCursor : null}} satisfies Schema["LedgerSearchResultV1"]);
  });
  return state;
}

export async function signInAnalysis(page:Page) {
  await page.goto("/analysis");await page.getByRole("button",{name:"Continue as Aino",exact:true}).click();
  await page.getByRole("heading",{name:"Follow the spending.",exact:true}).waitFor();
}
