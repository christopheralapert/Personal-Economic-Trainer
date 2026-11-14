"use client";

import {useEffect, useRef, useState, type FormEvent} from "react";
import type {components} from "@contracts";
import {aborted, PrivateApiError, type PrivateRequest} from "./private-session";
import {euros, planDate} from "./plan-format";
import {CoachQuery} from "./coach-query";

type Schema = components["schemas"];
type Filters = {start: string; end_exclusive: string; merchant: string; category: string};
type Query = Schema["SpendingArgumentsV1"];
type Totals = Schema["SpendingTotalsV1"];
type LedgerPage = Schema["LedgerPageV1"];
type Result = {totals: Totals; page: LedgerPage; query: Query; pageNumber: number};
const initialFilters: Filters = {start: "2026-10-01", end_exclusive: "2026-11-01", merchant: "", category: ""};
const baskets: Record<string, string> = {mandatory_regular: "Regular essentials", mandatory_irregular: "Irregular essentials", everyday: "Everyday spending"};

function sameScope(left: Totals["scope"], right: LedgerPage["scope"]) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readError(reason: unknown) {
  if (reason instanceof PrivateApiError) {
    if (["DATA_VERSION_CHANGED", "CURSOR_SCOPE_CHANGED", "INVALID_CURSOR"].includes(reason.code))
      return "Your data changed while reading. Inspect spending again to start from a current snapshot.";
    if (["BANK_ACCOUNT_ACCESS_REQUIRED", "BANK_SOURCE_NOT_READY", "SYNTHETIC_BANKS_ONLY"].includes(reason.code))
      return "A bank source needs attention. Review your bank connections, then inspect spending again.";
  }
  return "Spending could not be read. Check your connection and source access, then choose Inspect spending to retry.";
}

export function AnalysisWorkspace({request,synthetic=true,initialMode="filters"}: {request: PrivateRequest;synthetic?:boolean;initialMode?:"filters"|"question"}) {
  const [mode,setMode]=useState<"filters"|"question">(initialMode);
  const [filters, setFilters] = useState<Filters>(()=>{const today=new Date();return {...initialFilters,start:new Date(Date.UTC(today.getFullYear(),today.getMonth()-1,1)).toISOString().slice(0,10),end_exclusive:new Date(Date.UTC(today.getFullYear(),today.getMonth(),1)).toISOString().slice(0,10)};});
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => () => { latest.current += 1; }, []);
  useEffect(() => { if (result) heading.current?.focus(); }, [result]);

  const days = (Date.parse(`${filters.end_exclusive}T00:00:00Z`) - Date.parse(`${filters.start}T00:00:00Z`)) / 86400000;
  const validPeriod = Number.isInteger(days) && days >= 1 && days <= 366;

  function edit(changes: Partial<Filters>) {
    latest.current += 1;
    setFilters(value => ({...value, ...changes}));
    setResult(null); setBusy(false); setError("");
  }

  async function inspect(event: FormEvent) {
    event.preventDefault();
    if (busy || !validPeriod) return;
    const generation = ++latest.current;
    const query: Query = {...filters, merchant: filters.merchant || null, category: filters.category || null,
      currency: "EUR", account_ids: null, expected_data_version: null};
    setBusy(true); setResult(null); setError("");
    try {
      const totals = await request<Schema["SpendingToolResultV1"]>("analysis/tools/execute", {name: "spending_totals", arguments: query});
      if (generation !== latest.current) return;
      const scoped = {...query, expected_data_version: totals.result.scope.data_version};
      const page = await request<Schema["LedgerSearchResultV1"]>("analysis/tools/execute", {name: "ledger_transactions",
        arguments: {...scoped, status: "booked", spending_only: true, cursor: null, limit: 25}});
      if (generation !== latest.current) return;
      if (!sameScope(totals.result.scope, page.result.scope)) throw new PrivateApiError("DATA_VERSION_CHANGED", "The source changed.");
      setResult({totals: totals.result, page: page.result, query: scoped, pageNumber: 1});
    } catch (reason) {
      if (!aborted(reason) && generation === latest.current) setError(readError(reason));
    } finally { if (generation === latest.current) setBusy(false); }
  }

  async function nextPage() {
    if (!result?.page.next_cursor || busy) return;
    const previous = result, generation = ++latest.current;
    setBusy(true); setError("");
    try {
      const page = await request<Schema["LedgerSearchResultV1"]>("analysis/tools/execute", {name: "ledger_transactions",
        arguments: {...previous.query, status: "booked", spending_only: true, cursor: previous.page.next_cursor, limit: 25}});
      if (generation !== latest.current) return;
      if (!sameScope(previous.totals.scope, page.result.scope)) throw new PrivateApiError("DATA_VERSION_CHANGED", "The source changed.");
      setResult({...previous, page: page.result, pageNumber: previous.pageNumber + 1});
    } catch (reason) {
      if (!aborted(reason) && generation === latest.current) {setResult(null); setError(readError(reason));}
    } finally { if (generation === latest.current) setBusy(false); }
  }

  return <>
    <div className="page-heading"><div><h1>Follow the spending.</h1><p>Ask about your records or choose filters and inspect the transactions behind your totals.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>{synthetic ? "Signed-in synthetic data" : "Verified profile records"} · Calculated from your owned ledger. No model call is needed.</span></p>
    <div className="plan-actions analysis-mode" role="group" aria-label="Choose how to explore">{(["filters","question"] as const).map(value=><button type="button" key={value}
      className={mode===value ? "primary-button" : "secondary-button"} aria-pressed={mode===value}
      onClick={()=>{latest.current++;setResult(null);setBusy(false);setError("");setMode(value);}}>{value==="filters" ? "Use filters" : "Ask a question"}</button>)}</div>
    {mode==="question" ? <CoachQuery request={request}/> : <>
    <section className="panel analysis-query" aria-labelledby="analysis-query-title">
      <h2 id="analysis-query-title">Choose what to inspect</h2>
      <p className="field-hint">Uses all included EUR accounts. These are booked spending observations; <a href="/plan">your reviewed plan</a> explains what you can afford.</p>
      <form onSubmit={event => void inspect(event)}>
        <div className="plan-fields">
          <label className="plan-field">From (included)<input type="date" required max="9999-12-31" value={filters.start} onChange={event => edit({start: event.target.value})} aria-describedby="analysis-period-hint"/></label>
          <label className="plan-field">Until (excluded)<input type="date" required max="9999-12-31" value={filters.end_exclusive} onChange={event => edit({end_exclusive: event.target.value})} aria-describedby="analysis-period-hint"/></label>
        </div>
        <p id="analysis-period-hint" className="field-hint">Choose 1–366 booking days. For all of October, use 1 October until 1 November. The final date is excluded.</p>
        <div className="plan-fields">
          <label className="plan-field">Merchant contains<input value={filters.merchant} maxLength={200} autoComplete="off" onChange={event => edit({merchant: event.target.value})} aria-describedby="analysis-filter-hint"/></label>
          <label className="plan-field">Category (exact)<input value={filters.category} maxLength={100} autoComplete="off" onChange={event => edit({category: event.target.value})} aria-describedby="analysis-filter-hint"/></label>
        </div>
        <p id="analysis-filter-hint" className="field-hint">Both filters are optional. Merchant search matches literal text; use the category identifier shown on a transaction, such as dining.</p>
        {!validPeriod && <p className="analysis-period-error" role="alert">Choose an end after the start, with at most 366 days. Longer periods have not been shortened.</p>}
        <div className="plan-actions"><button className="primary-button" disabled={busy || !validPeriod}>Inspect spending</button><a className="text-button" href="/banks">Review included accounts</a></div>
      </form>
    </section>
    {busy && <p className="analysis-feedback field-hint" role="status">Reading the selected spending and its transaction evidence…</p>}
    {error && <p className="error-notice" role="alert">{error}</p>}
    {result ? <section className="panel analysis-results" aria-labelledby="analysis-results-title" aria-busy={busy}>
      <h2 id="analysis-results-title" tabIndex={-1} ref={heading}>Observed spending</h2>
      <p className="field-hint"><time dateTime={result.totals.scope.start}>{result.totals.scope.start}</time> until <time dateTime={result.totals.scope.end_exclusive}>{result.totals.scope.end_exclusive}</time> (end excluded) · {result.totals.scope.account_ids.length} included EUR account(s).</p>
      <p className="analysis-filter-summary">{result.query.merchant ? <>Merchant contains <strong>{result.query.merchant}</strong>. </> : "All merchants. "}{result.query.category ? <>Exact category: <strong>{result.query.category}</strong>.</> : "All categories."}</p>
      {result.totals.scope.dataset_coverage !== "covered_synthetic_snapshot" && <p className="analysis-coverage">History coverage is incomplete or unverified. These observed totals do not establish complete spending, including when no matches are found. <a href="/banks">Review source coverage.</a></p>}
      <dl className="plan-breakdown analysis-totals">
        <div><dt>Gross booked expenses <span>({result.totals.expense_count} entries)</span></dt><dd>{euros(result.totals.gross_minor)}</dd></div>
        <div><dt>Booked refunds <span>({result.totals.refund_count} entries)</span></dt><dd>{euros(result.totals.refunds_minor)}</dd></div>
        <div className="analysis-net"><dt>Net observed spending</dt><dd>{euros(result.totals.net_minor)}</dd></div>
      </dl>
      <p className="field-hint">Gross expenses minus refunds in this exact scope. Pending charges and transfers are excluded. This is historical spending, not an available balance or a spending allowance.</p>
      {result.totals.expense_count + result.totals.refund_count === 0 && <p className="bank-empty">No matching booked spending. The searched scope is shown above; missing history and spending outside it remain unknown.</p>}
      {result.totals.category_baskets.length > 0 && <div className="analysis-section"><h3>By category</h3>
        <ul className="analysis-group-list">{result.totals.category_baskets.map(group => <li key={`${group.label}:${group.basket}`}><div><strong>{group.label}</strong><span>{baskets[group.basket ?? ""] ?? "Basket needs review"} · {group.transaction_count} entries</span></div><strong>{euros(group.net_minor)}</strong></li>)}</ul>
        {result.totals.category_breakdown_truncated && <p className="field-hint">The category breakdown is truncated. The total above includes the full matching scope.</p>}
      </div>}
      <div className="analysis-section"><h3>Matching transactions</h3>
        <p className="field-hint">Page {result.pageNumber} · {result.page.rows.length} entries on this page, newest first. Refunds reduce net spending. Each page replaces the previous one.</p>
        <ul className="analysis-transactions">{result.page.rows.map(row => <li key={row.id}>
          <div><strong>{row.merchant}</strong><span><time dateTime={row.booked_on}>{row.booked_on}</time> · {row.category} · {baskets[row.basket] ?? "Basket needs review"}</span></div>
          <div className="analysis-transaction-amount"><strong>{euros(row.amount_minor)}</strong><span>{row.economic_flow === "refund" ? "Refund" : "Expense"}</span></div>
        </li>)}</ul>
        {result.page.next_cursor && <button className="secondary-button" disabled={busy} onClick={() => void nextPage()}>Next transactions</button>}
      </div>
      <details className="plan-evidence"><summary>Source and scope details</summary>
        <dl className="plan-breakdown"><div><dt>Data / plan version</dt><dd>{result.totals.scope.data_version} / {result.totals.scope.plan_version}</dd></div><div><dt>History coverage</dt><dd>{result.totals.scope.dataset_coverage === "covered_synthetic_snapshot" ? "Covered synthetic snapshot for this window" : "Incomplete or unverified"}</dd></div></dl>
        <p>Account ownership does not confirm complete household finances. EUR scope is explicit; other currencies are not converted.</p>
        {(result.totals.scope.sources ?? []).map(source => <div className="analysis-source" key={source.account_id}><h3>{source.institution_id} · {source.mode}</h3>
          <p>Consent: {source.consent_state}. Source health: {source.sync_health}. Observed: {source.observed_at ? planDate(source.observed_at) + " (Helsinki)" : "unknown"}.</p>
          <p>History: {source.history_from ?? "unknown"} until {source.history_to_exclusive ?? "unknown"} (end excluded). Source version: {source.source_version ?? "unknown"}.</p>
        </div>)}
        {(result.totals.scope.unverified_account_ids?.length ?? 0) > 0 && <p>{result.totals.scope.unverified_account_ids?.length} account(s) have no verified source history in this scope.</p>}
        {result.totals.unresolved_flow_count > 0 && <p>{result.totals.unresolved_flow_count} entries have an unresolved economic relationship and are excluded from consumption.</p>}
        <ul>{result.totals.limitations.map((limitation, index) => <li key={index}>{limitation}</li>)}</ul>
      </details>
    </section> : !busy && !error && <p className="analysis-empty field-hint">Your results will appear here after you inspect a period. Changing a filter clears the previous result.</p>}
    </>}
  </>;
}
