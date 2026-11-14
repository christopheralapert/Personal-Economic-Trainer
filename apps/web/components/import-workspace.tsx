"use client";

import {useEffect,useRef,useState} from "react";
import type {components} from "@contracts";
import {aborted,type PrivateRequest,type PrivateTransfer} from "./private-session";
import {roleNames,sizeLabel,sourceProblem} from "./import-files";
import {useImportWorkspace} from "./use-import-workspace";
import {ImportRecords} from "./import-records";

type Schema=components["schemas"];
const labels:Record<string,string>={awaiting_uploads:"Waiting for files",queued:"Background work pending",source_ready:"File integrity checked",failed:"Needs attention",cancelled:"Cancelled",validated:"Rows checked",invalid:"Source needs correction",published:"Ready for analysis",superseded:"Earlier export"};
const retryable=new Set(["import_source_version_changed","import_publication_failed","attempts_exhausted","permission_changed"]);
const reasons:Record<string,string>={invalid_integer:"Use canonical whole minor units, without decimal fractions or exponents.",integer_out_of_range:"The integer is outside the supported range.",source_customer_mismatch:"The row belongs to another declared source customer.",currency_mismatch:"The row's currency differs from its source manifest.",booking_outside_coverage:"The booking date is outside the declared source window.",invalid_aware_instant:"The observation needs an explicit valid UTC offset.",future_observation:"The observation is later than the source check allows.",unknown_account_reference:"This row has no accepted account in the same source.",duplicate_source_reference:"This source identity is repeated.",invalid_column_count:"The row has an unexpected number of columns."};

function Rejections({request,identifier}:{request:PrivateRequest;identifier:string}) {
  const [page,setPage]=useState<Schema["ImportRejectionsV1"]|null>(null),[error,setError]=useState("");
  const [busy,setBusy]=useState(false);const epoch=useRef(0);
  useEffect(()=>()=>{epoch.current++;},[]);
  const load=async (after=0)=>{
    const generation=++epoch.current;setPage(null);setError("");setBusy(true);
    try {
      const result=await request<Schema["ImportRejectionsV1"]>(`imports/${identifier}/validation/rejections?after=${after}&limit=20`);
      if (generation===epoch.current) setPage(result);
    } catch (reason) {if (generation===epoch.current && !aborted(reason)) setError("The issue report could not be loaded. Check the import status and try again.");}
    finally {if (generation===epoch.current) setBusy(false);}
  };
  return <section className="import-subsection" aria-labelledby="import-issues-heading"><h3 id="import-issues-heading">Rows to review</h3>
    <p className="field-hint">Original values stay in the private file. These reasons identify where the source needs correction.</p>
    <button className="secondary-button" disabled={busy} onClick={()=>void load()}>Read source issues</button>
    {busy && <p role="status">Loading source issues…</p>}{error && <p role="alert" className="error-notice">{error}</p>}
    {page && <><ul className="import-issues">{page.rows.map(row=><li key={row.position}>
      <strong>{roleNames[row.role]} · row {row.ordinal}</strong><p>{row.reasons.map(reason=>reasons[reason] ?? "Review the row's field values against the compatible export format.").join(" ")}</p>
      {row.fields.length>0 && <p className="field-hint">Fields: {row.fields.join(", ")}</p>}
      <details><summary>Source evidence</summary><p className="field-hint">Bytes {row.byte_start}–{row.byte_end} (end excluded) · SHA-256: <span className="import-digest">{row.raw_sha256}</span></p></details>
    </li>)}</ul>{page.rows.length===0 && <p className="field-hint">No rejected row is recorded on this page. Check the source status for file-level or control-total errors.</p>}
      {page.next_after!==null && <button className="text-button" disabled={busy} onClick={()=>void load(page.next_after!)}>Next source issues</button>}</>}
  </section>;
}

export function ImportWorkspace({request,transfer,changed}:{request:PrivateRequest;transfer:PrivateTransfer;changed:()=>void}) {
  const work=useImportWorkspace(request,transfer,changed);
  const source=work.detail?.intake,validation=work.detail?.validation,publication=work.detail?.publication;
  const enabled=!!work.capabilities?.enabled;
  const canUpload=!!source && ["awaiting_uploads","failed"].includes(source.state) && !validation && !publication;
  const canValidate=source?.state==="source_ready" && !publication && (!validation || ["failed","cancelled"].includes(validation.state));
  const canPublish=validation?.state==="validated" && (!publication || (["failed","cancelled"].includes(publication.state) &&
    (!publication.last_error_code || retryable.has(publication.last_error_code))));
  const problem=publication?.last_error_code ?? validation?.last_error_code ?? source?.job?.last_error_code ?? null;
  const state=publication?.state ?? validation?.state ?? source?.state;
  const stage=publication ? 3 : validation ? 2 : 1;
  const fileSelection=work.manifest && (!work.identifier || canUpload || (work.reading && Object.values(work.selected).some(Boolean)));

  return <div className="import-workspace">
    <p className="field-hint">Use a compatible synthetic export with its small JSON manifest and CSV files. Send the files, check their rows, then choose whether to use them in your private analysis.</p>
    <div className="plan-actions"><button className="text-button" disabled={work.busy} onClick={work.reload}>Check import status</button>
      {work.identifier && <button className="text-button" disabled={work.locked} onClick={work.reset}>Prepare another source</button>}</div>
    {work.loading && <p role="status" className="field-hint">Loading your source history…</p>}
    {work.capabilities && !enabled && <p className="import-unavailable">{work.capabilities.notice}</p>}
    {work.error && <p className="error-notice" role="alert">{work.error}</p>}
    {work.pending && !work.busy && <div className="plan-blockers"><p>The last request is unconfirmed. Its original command remains only in this window; no new change will be sent automatically.</p><button className="secondary-button" onClick={work.retry}>Retry the same import request</button></div>}
    <p className="import-feedback" role="status">{work.sending ? `Sending ${roleNames[work.sending].toLowerCase()} directly to private storage…` : work.busy ? "Confirming your source request…" : work.notice}</p>

    {!work.identifier && <section className="import-subsection" aria-labelledby="import-new-heading"><h3 id="import-new-heading">Prepare your source files</h3>
      <p className="field-hint">Choose the export manifest first, then its matching CSV files. Your original files remain unchanged.</p>
      <label className="plan-field">Export manifest (JSON, up to 8 KiB)<input type="file" accept=".json,application/json" disabled={!enabled || work.locked}
        onChange={event=>void work.chooseManifest(event.target.files?.[0])}/></label>
      {work.parsing && <p role="status">Reading the small manifest…</p>}
    </section>}

    {work.manifest && <section className="import-subsection" aria-labelledby="import-source-heading">
      <h3 id="import-source-heading">{work.manifest.source_version}</h3>
      <p className="field-hint">{work.manifest.currency} · Declared booking window {work.manifest.claimed_from} to {work.manifest.claimed_to_exclusive} (end excluded) · {sizeLabel(work.manifest.files.reduce((total,file)=>total+file.size_bytes,0))}</p>
      {work.manifestName && <p className="field-hint">Selected manifest: {work.manifestName}</p>}
      {fileSelection && <fieldset className="import-file-fields" key={work.selectionVersion}><legend>Choose the original export files</legend>
        {work.manifest.files.map(file=><label className="plan-field" key={file.role}>{roleNames[file.role]} CSV · expected {sizeLabel(file.size_bytes)}
          <input type="file" accept=".csv,text/csv" disabled={!enabled || work.locked} onChange={event=>work.chooseFile(file.role,event.target.files?.[0])}/>
          {work.selected[file.role] && <span className="field-hint">{work.selected[file.role]!.name} · {work.selected[file.role]!.size===file.size_bytes ? "Size matches the manifest" : "Size does not match; choose the original file"}</span>}
        </label>)}
      </fieldset>}
      {!work.identifier && <div className="plan-actions"><button className="primary-button" disabled={!enabled || work.locked} onClick={work.prepare}>Prepare private upload</button><span className="field-hint">Preparing stores only the manifest. Uploading is a separate choice.</span></div>}
      {work.reading && <p role="status" className="field-hint">Checking the latest source state…</p>}
      {work.detail && <>
        <ol className="import-steps" aria-label="Import stages">
          <li aria-current={stage===1 ? "step" : undefined}><strong>Send and check files</strong><span>{stage>1 || source?.source_integrity_verified ? "Integrity checked" : labels[source?.state ?? "awaiting_uploads"]}</span></li>
          <li aria-current={stage===2 ? "step" : undefined}><strong>Check source rows</strong><span>{validation ? labels[validation.state] : "Not requested"}</span></li>
          <li aria-current={stage===3 ? "step" : undefined}><strong>Use in your analysis</strong><span>{publication ? labels[publication.state] : "Not requested"}</span></li>
        </ol>
        <p className="import-state"><strong>{labels[state ?? "awaiting_uploads"]}</strong>{work.polling && " · Checking background progress"}</p>
        {problem && <p className="import-problem">{sourceProblem(problem)}</p>}
        {validation && <><p className="field-hint">{validation.processed_rows} rows processed · {validation.accepted_rows} accepted · {validation.rejected_rows} need correction. These are source checks, not spending totals.</p>
          <ul className="import-file-progress">{validation.files.map(file=><li key={file.role}>{roleNames[file.role]} · {file.processed_rows} rows · {file.complete ? "File complete" : `${sizeLabel(file.offset_bytes)} of ${sizeLabel(file.size_bytes)} checked`}</li>)}</ul></>}
        {publication && <p className="field-hint">{publication.account_count} account(s) · {publication.transaction_count} transaction(s) · {publication.balance_count} balance observation(s). {publication.active ? "This export is in use for your private analysis." : publication.state==="superseded" ? "A newer export is in use; this record is retained as history." : "Your previous data stays in use until this change succeeds."}</p>}
        <div className="plan-actions">
          {canUpload && <><button className="primary-button" disabled={!enabled || work.locked || work.manifest.files.some(file=>work.selected[file.role]?.size!==file.size_bytes)} onClick={()=>void work.upload()}>Upload and check files</button>
            <button className="secondary-button" disabled={!enabled || work.locked} onClick={()=>work.action("submit")}>Check uploaded files</button></>}
          {canValidate && <button className="primary-button" disabled={!enabled || work.locked} onClick={()=>work.action("validation")}>{validation ? "Resume source row checks" : "Check source rows"}</button>}
          {canPublish && <button className="primary-button" disabled={!enabled || work.locked} onClick={()=>work.action("publication")}>{publication ? "Retry using checked data" : "Use checked data"}</button>}
          {source?.state==="awaiting_uploads" && !validation && <button className="text-button" disabled={work.locked} onClick={()=>work.action("cancel")}>Abandon this upload</button>}
          {validation?.state==="queued" && !publication && <button className="text-button" disabled={work.locked} onClick={()=>work.action("validation/cancel")}>Cancel row checks</button>}
          {publication?.state==="queued" && <button className="text-button" disabled={work.locked} onClick={()=>work.action("publication/cancel")}>Cancel this change</button>}
        </div>
        {canPublish && <p className="field-hint">Using this export replaces the previous version from the same source. Saved calculations will need a fresh review. It does not transfer or reserve money.</p>}
        {validation?.state==="invalid" && <Rejections key={work.detail.id} request={request} identifier={work.detail.id}/>}
        {publication?.active && <ImportRecords key={publication.id} request={request} source={publication}/>}
      </>}
    </section>}

    {work.history && <section className="import-subsection" aria-labelledby="import-history-heading"><h3 id="import-history-heading">Your saved sources</h3>
      <p className="field-hint">Source history stays with your verified profile. File selections and unconfirmed commands are cleared when this private view closes.</p>
      {work.history.rows.length===0 ? <p className="bank-empty">No source file import is saved yet.</p> : <ul className="import-history">{work.history.rows.map(item=><li key={item.id}>
        <div><strong>{item.source_version}</strong><p className="field-hint">{item.currency} · {sizeLabel(item.total_bytes)} · {labels[item.id===work.detail?.id ? state ?? item.intake_state : item.publication_state ?? item.validation_state ?? item.intake_state]}</p></div>
        <button className="text-button" disabled={work.locked} onClick={()=>void work.open(item.id)}>Open source {item.source_version}</button>
      </li>)}</ul>}
      {work.history.next_before_id && <button className="text-button" disabled={work.loading} onClick={work.more}>Earlier saved sources</button>}
    </section>}
  </div>;
}
