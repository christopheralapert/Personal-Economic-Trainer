import {expect,type Page} from "@playwright/test";
import {createHash,randomUUID} from "node:crypto";
import type {components} from "../../packages/contracts/api";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";
import exportManifest from "../../fixtures/synthetic/import-v1/manifest.json";
import {banks,signInBanks} from "./bank-support";

type Schema=components["schemas"];
export const manifest=exportManifest as Schema["ImportManifestV1"];
const instant="2026-11-04T00:00:00+02:00";
const id="00000000-0000-0000-0000-000000000201";
const run="00000000-0000-0000-0000-000000000202";
const publicationId="00000000-0000-0000-0000-000000000203";
export const nativeAccount="00000000-0000-0000-0000-000000000204";
const feed="00000000-0000-0000-0000-000000000205";
const jobId="00000000-0000-0000-0000-000000000206";
export const storageOrigin="http://127.0.0.1:9000";
export const capabilityMarker="test-only-private-upload-signature";

export async function mockImports(page:Page,options:{unavailable?:boolean;loseCreate?:boolean;losePublication?:boolean;invalidRows?:boolean;stallUpload?:boolean}={}) {
  await page.clock.install({time:new Date(instant)});
  const session=structuredClone(fixture.session) as Schema["SessionView"];
  let signedIn=false,created=false,byteState:Schema["ImportViewV1"]["state"]="awaiting_uploads";
  let rowState:Schema["ImportValidationViewV1"]["state"]|null=null,pubState:Schema["ImportPublicationViewV1"]["state"]|null=null;
  let lostCreate=false,lostPublication=false,release:()=>void=()=>{};
  const stalled=new Promise<void>(resolve=>{release=resolve;});
  const receipts=new Map<string,unknown>();
  const calls:{path:string;body:Record<string,unknown>}[]=[],uploads:{role:string;headers:Record<string,string>;bytes:number}[]=[];
  const job=(type:string,state:Schema["JobStatusView"]["state"]):Schema["JobStatusView"]=>({id:jobId,type,state,attempts:state==="queued" ? 0 : 1,max_attempts:3,
    available_at:instant,lease_until:null,finished_at:state==="completed" ? instant : null,last_error_code:null});
  const summary=():Schema["ImportSummaryV1"]=>({id,source_version:manifest.source_version,currency:manifest.currency,created_at:instant,
    total_bytes:manifest.files.reduce((sum,file)=>sum+file.size_bytes,0),intake_state:pubState==="published" ? "published" : byteState,
    validation_state:rowState,publication_state:pubState,active:pubState==="published"});
  const source=():Schema["ImportViewV1"]=>({id,state:byteState,manifest,files:manifest.files.map(file=>({...file,verified_at:byteState==="source_ready" ? instant : null})),
    created_at:instant,updated_at:instant,upload_expires_at:"2026-11-05T00:00:00+02:00",job:byteState==="queued" ? job("import.verify_source","queued") : byteState==="source_ready" ? job("import.verify_source","completed") : null,
    source_integrity_verified:byteState==="source_ready",published:false,mode:"synthetic",as_of:instant,limitations:["Synthetic transport fixture; no financial publication from byte checks."]});
  const rows=():Schema["ImportValidationViewV1"]=>({schema_version:"import-validation.v1",id:run,import_id:id,state:rowState!,parser_version:"moneylens.csv-parser.v1",
    generation:1,sequence:rowState==="queued" ? 0 : 3,processed_rows:rowState==="queued" ? 0 : 14,accepted_rows:rowState==="queued" ? 0 : rowState==="invalid" ? 13 : 14,
    rejected_rows:rowState==="invalid" ? 1 : 0,files:manifest.files.map(file=>({role:file.role,size_bytes:file.size_bytes,offset_bytes:rowState==="queued" ? 0 : file.size_bytes,
      processed_rows:rowState==="queued" ? 0 : file.role==="transactions" ? 12 : 1,complete:rowState!=="queued"})),created_at:instant,updated_at:instant,finished_at:rowState==="queued" ? null : instant,
    last_error_code:rowState==="invalid" ? "import_rejected_rows" : null,job:job("import.validate_chunk",rowState==="queued" ? "queued" : rowState==="cancelled" ? "cancelled" : "completed"),publication:"separate_workflow",mode:"synthetic",limitations:[]});
  const publication=():Schema["ImportPublicationViewV1"]=>({schema_version:"import-publication.v1",id:publicationId,import_id:id,run_id:run,feed_id:feed,state:pubState!,active:pubState==="published",
    active_publication_id:pubState==="published" ? publicationId : null,generation:1,manifest,source_manifest_sha256:"a".repeat(64),account_count:1,transaction_count:12,balance_count:1,
    created_at:instant,updated_at:instant,published_at:pubState==="published" ? instant : null,published_data_version:pubState==="published" ? 2 : null,last_error_code:null,
    job:job("import.publish",pubState==="queued" ? "queued" : pubState==="cancelled" ? "cancelled" : "completed"),mode:"synthetic",limitations:[]});

  await page.route(`${storageOrigin}/native-ui/**`,async route=>{
    const request=route.request(),role=new URL(request.url()).pathname.split("/").at(-1)!.replace(".csv","");
    const headers={"Access-Control-Allow-Origin":"http://127.0.0.1:31311","Access-Control-Allow-Methods":"PUT","Access-Control-Allow-Headers":"content-type,if-none-match,x-amz-checksum-sha256"};
    if (request.method()==="OPTIONS") return route.fulfill({status:204,headers});
    const body=request.postDataBuffer()!,actualHeaders=await request.allHeaders();
    expect(request.method()).toBe("PUT");expect(actualHeaders.cookie).toBeUndefined();expect(actualHeaders.authorization).toBeUndefined();expect(actualHeaders.referer).toBeUndefined();
    expect(actualHeaders["if-none-match"]).toBe("*");
    const declared=manifest.files.find(file=>file.role===role)!;
    expect(body.length).toBe(declared.size_bytes);expect(createHash("sha256").update(body).digest("hex")).toBe(declared.sha256);
    uploads.push({role,headers:actualHeaders,bytes:body.length});
    if (options.stallUpload && role==="transactions") await stalled;
    await route.fulfill({status:200,headers,body:""}).catch(error=>{if (!String(error).includes("closed") && !String(error).includes("handled")) throw error;});
  });

  await page.route("**/api/v1/**",async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace("/api/v1/","");
    const respond=(value:unknown,status=200)=>route.fulfill({status,json:value,headers:{"Cache-Control":"private, no-store"}});
    const missing=()=>respond({error:{code:"NOT_FOUND",message:"This owned source resource is not available."}},404);
    if (path==="auth/demo") {signedIn=true;return respond(session);}
    if (path==="auth/logout") {signedIn=false;return route.fulfill({status:204});}
    if (!signedIn) return respond({error:{code:"UNAUTHENTICATED",message:"Sign in to continue."}},401);
    if (path==="auth/session") return respond(session);
    expect(request.headers()["x-moneylens-session-id"]).toBe(session.session_id);
    if (path==="banks") return respond(banks);
    if (path==="bank-connections" && request.method()==="GET") return respond([]);
    if (path==="accounts/sources") return respond([]);
    if (path==="imports/capabilities") return respond({enabled:!options.unavailable && session.synthetic,synthetic_only:true,mapping_version:"moneylens.synthetic-csv.v1",
      maximum_manifest_bytes:8192,maximum_source_bytes:1024**3,notice:options.unavailable || !session.synthetic ? "File import is unavailable here. Existing imports can still be reviewed." : "Compatible synthetic file imports are configured for this profile."} satisfies Schema["ImportCapabilitiesV1"]);
    if (path==="imports" && request.method()==="GET") return respond({rows:created ? [summary()] : [],next_before_id:null,traversal:"live-owned-created-order"} satisfies Schema["ImportListV1"]);
    if (request.method()==="GET") {
      if (!created) return missing();
      if (path===`imports/${id}`) return pubState==="published" ? respond({error:{code:"IMPORT_INTAKE_MOVED",message:"Read the publication resource."}},409) : respond(source());
      if (path===`imports/${id}/validation`) return rowState ? respond(rows()) : missing();
      if (path===`imports/${id}/publication`) return pubState ? respond(publication()) : missing();
      if (path.endsWith("/validation/rejections")) return respond({import_id:id,run_id:run,rows:[{position:2,role:"transactions",ordinal:1,byte_start:200,byte_end:300,
        raw_sha256:"b".repeat(64),reasons:["invalid_integer"],fields:["amount_minor"]}],next_after:null,traversal:"live-owned-position",notice:"Raw values remain private."} satisfies Schema["ImportRejectionsV1"]);
      if (path.endsWith("/publication/accounts")) return respond({publication_id:publicationId,active:true,accounts:[{id:nativeAccount,name:"Authored synthetic account",currency:"EUR",account_type:"current",included:true}]} satisfies Schema["NativeAccountListV1"]);
      if (path.endsWith("/publication/transactions")) {
        expect(url.searchParams.get("account_id")).toBe(nativeAccount);
        expect(url.searchParams.get("currency")).toBe(manifest.currency);
        const second=url.searchParams.has("cursor"),empty=url.searchParams.get("merchant")==="does not exist";
        return respond({scope:{data_mode:"synthetic",account_ids:[nativeAccount],currency:"EUR",start:"2026-10-01",end_exclusive:"2026-11-01",permission_version:1,data_version:2,plan_version:1,
          dataset_coverage:"unverified",scope_kind:"selected_accounts",whole_finances_confirmed:false,sources:[],unverified_account_ids:[nativeAccount]},
          rows:empty ? [] : [1,2].map(index=>({id:`00000000-0000-0000-0000-0000000003${second ? 10+index : index.toString().padStart(2,"0")}`,account_id:nativeAccount,
            amount_minor:-125,currency:"EUR",booked_on:"2026-10-15",status:"booked",merchant:"Synthetic cafe",category:"coffee",basket:"everyday",economic_flow:"expense"})),next_cursor:empty || second ? null : "native-ui-only-cursor"} satisfies Schema["LedgerPageV1"]);
      }
      return missing();
    }
    expect(request.headers()["x-csrf-token"]).toBe(session.csrf_token);
    const body=request.postDataJSON() as Record<string,unknown>;calls.push({path,body:structuredClone(body)});
    const receiptKey=String(body.key ?? "");
    if (receiptKey && receipts.has(receiptKey)) return respond(receipts.get(receiptKey),path.endsWith("/cancel") ? 200 : 202);
    const base={id:randomUUID(),import_id:id,applied_at:instant,historical_command_snapshot:true as const};
    if (path==="imports") {
      created=true;const receipt:Schema["ImportReceiptV1"]={...base,schema_version:"import-command.v1",action:"start",state:"awaiting_uploads",job_id:null};receipts.set(receiptKey,receipt);
      if (options.loseCreate && !lostCreate) {lostCreate=true;return route.abort("failed");}
      return respond(receipt,202);
    }
    if (path.endsWith("/upload-links")) return respond({import_id:id,expires_at:"2026-11-04T00:10:00+02:00",notice:"Private test capability.",files:manifest.files.map(file=>({role:file.role,method:"PUT" as const,
      url:`${storageOrigin}/native-ui/${file.role}.csv?X-Amz-Signature=${capabilityMarker}`,size_bytes:file.size_bytes,headers:{"Content-Type":"text/csv","If-None-Match":"*","x-amz-checksum-sha256":Buffer.from(file.sha256,"hex").toString("base64")}}))} satisfies Schema["ImportUploadLinksV1"]);
    if (path.endsWith("/submit")) {
      byteState="queued";const receipt:Schema["ImportReceiptV1"]={...base,schema_version:"import-command.v1",action:"submit",state:"queued",job_id:jobId};receipts.set(receiptKey,receipt);return respond(receipt,202);
    }
    if (path.endsWith("/validation")) {
      rowState="queued";const receipt:Schema["ImportValidationReceiptV1"]={...base,schema_version:"import-validation-command.v1",run_id:run,action:"start",state:"queued",job_id:jobId};receipts.set(receiptKey,receipt);return respond(receipt,202);
    }
    if (path.endsWith("/publication")) {
      pubState="queued";const receipt:Schema["ImportPublicationReceiptV1"]={...base,schema_version:"import-publication-command.v1",publication_id:publicationId,feed_id:feed,action:"start",state:"queued",job_id:jobId};receipts.set(receiptKey,receipt);
      if (options.losePublication && !lostPublication) {lostPublication=true;return route.abort("failed");}
      return respond(receipt,202);
    }
    if (path.endsWith("/publication/cancel")) {
      pubState="cancelled";const receipt:Schema["ImportPublicationReceiptV1"]={...base,schema_version:"import-publication-command.v1",publication_id:publicationId,feed_id:feed,action:"cancel",state:"cancelled",job_id:jobId};receipts.set(receiptKey,receipt);return respond(receipt);
    }
    if (path.endsWith("/validation/cancel")) {
      rowState="cancelled";const receipt:Schema["ImportValidationReceiptV1"]={...base,schema_version:"import-validation-command.v1",run_id:run,action:"cancel",state:"cancelled",job_id:jobId};receipts.set(receiptKey,receipt);return respond(receipt);
    }
    return missing();
  });
  return {calls,uploads,releaseUpload:release,finishFiles:()=>{byteState="source_ready";},finishRows:()=>{rowState=options.invalidRows ? "invalid" : "validated";},finishPublication:()=>{pubState="published";},
    revokeEligibility:()=>{session.synthetic=false;},created:()=>created};
}

export async function openImportFiles(page:Page) {await signInBanks(page);await page.getByText("Your data files",{exact:true}).click();await expect(page.getByText("No source file import is saved yet.")).toBeVisible();}
export async function chooseImportFiles(page:Page) {
  await page.getByLabel("Export manifest (JSON, up to 8 KiB)").setInputFiles("fixtures/synthetic/import-v1/manifest.json");
  for (const name of ["Accounts","Balances","Transactions"] as const) await page.getByLabel(new RegExp(`^${name} CSV`)).setInputFiles(`fixtures/synthetic/import-v1/${name.toLowerCase()}.csv`);
}
export async function createAndUpload(page:Page) {
  await chooseImportFiles(page);await page.getByRole("button",{name:"Prepare private upload",exact:true}).click();
  await expect(page.getByRole("button",{name:"Upload and check files",exact:true})).toBeEnabled();
  await page.getByRole("button",{name:"Upload and check files",exact:true}).click();
  await expect(page.getByRole("button",{name:"Cancel row checks",exact:true})).toHaveCount(0);
}

export async function finishToPublication(page:Page,state:Awaited<ReturnType<typeof mockImports>>) {
  await createAndUpload(page);
  await expect.poll(()=>state.calls.some(call=>call.path.endsWith("/submit"))).toBe(true);
  state.finishFiles();await page.clock.fastForward(5100);
  await page.getByRole("button",{name:"Check source rows",exact:true}).click();state.finishRows();await page.clock.fastForward(5100);
  await expect(page.getByRole("button",{name:"Use checked data",exact:true})).toBeEnabled();
}
