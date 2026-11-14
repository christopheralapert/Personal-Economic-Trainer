"use client";

import {useCallback, useEffect, useRef, useState, type FormEvent} from "react";
import type {components} from "@contracts";
import {aborted, PrivateApiError, type PrivateRequest} from "./private-session";
import {euros, planDate} from "./plan-format";

type Schema = components["schemas"];
type Comparison = Schema["PopulationComparisonV1"];
type Query = Schema["PopulationComparisonRequestV1"];
type Context = {catalog: Schema["HouseholdCohortCatalogV1"]; policy: Schema["CategoryCrosswalkViewV1"]; accounts: Schema["AccountWithSourceV1"][]};
const statusLabels = {comparable:"Comparable annual observations", approximate:"Approximate context", partial:"Some categories need review", withheld:"Comparison needs review", unavailable:"Comparison unavailable"};
const reasons: Record<string,string> = {
  HOUSEHOLD_COVERAGE_REQUIRED:"Confirm whether these accounts cover your household's expenses, including spending through other banks or cash.",
  KNOWN_ACCOUNT_SCOPE_INCOMPLETE:"Some known accounts are outside this scope. Review included accounts in your bank connections.",
  MATERIAL_BANK_SOURCE_INCOMPLETE:"A previously granted bank needs renewed access or a fresh published observation. Review your bank connections.",
  INCOMPLETE_ACCOUNT_HISTORY:"The bank history does not cover this entire period. Publish complete history or choose a covered period.",
  CURRENCY_NOT_COMPARABLE:"This comparison needs EUR source data. No currency conversion has been assumed.",
  UNRESOLVED_ECONOMIC_FLOWS:"Some transactions have an unresolved economic purpose. Review them before comparing consumption.",
  INCOMPLETE_CATEGORY_BREAKDOWN:"The category breakdown is incomplete. A complete source review is needed.",
  UNMAPPED_CATEGORY_COVERAGE:"Some source categories have no reviewed mapping. They cannot be treated as zero spending.",
  INCONSISTENT_CONSUMPTION_CATEGORY:"A transfer is classified as consumption. Review its economic purpose before comparing.",
  ANNUAL_WINDOW_REQUIRED:"Annual comparison requires twelve complete calendar months.",
  SHORT_PERIOD_APPROXIMATION_REQUIRES_CONFIRMATION:"Confirm the seasonal limitations of using less than a full year as monthly context.",
  REFERENCE_YEAR_MISMATCH:"Your spending period differs from the survey year. Confirm that you accept an older, unadjusted price reference.",
  AMBIGUOUS_CATEGORY_COVERAGE:"Some purchases cannot be assigned precisely to this survey category. Classify or split those purchases before comparing.",
  POPULATION_CELL_UNAVAILABLE:"This survey value is unavailable or suppressed. Choose another category or an explicit household group.",
  REFUND_DOMINATED_PERIOD:"Refunds exceed purchases in this period. Review the refund dates before interpreting consumption.",
  HOUSEHOLD_COHORT_UNAVAILABLE:"Choose a household group available in this source.",
  REFERENCE_PERIOD_UNAVAILABLE:"Choose the reference year available in this source.",
  VERIFIED_POPULATION_DATA_UNAVAILABLE:"The verified public snapshot is unavailable. Reload the source details later.",
  INCOMPATIBLE_POPULATION_SOURCE:"The public source and category mapping are incompatible. A verified source update is needed.",
};

function failure(reason: unknown) {
  if (reason instanceof PrivateApiError) {
    if (["BANK_ACCOUNT_ACCESS_REQUIRED","BANK_SOURCE_NOT_READY"].includes(reason.code)) return "A bank source needs attention. Review access and publish fresh observations in your bank connections, then reload these source details.";
    if (reason.code === "DATA_VERSION_CHANGED") return "Your transactions changed. Reload source details, then compare again.";
    return reason.message;
  }
  return "The comparison could not be loaded. Check your connection and try again.";
}

function monthWindow(first: string, last: string) {
  if (!/^\d{4}-\d{2}$/.test(first) || !/^\d{4}-\d{2}$/.test(last)) return null;
  const [fy,fm] = first.split("-").map(Number), [ly,lm] = last.split("-").map(Number);
  const count = (ly-fy)*12+lm-fm+1;
  if (fy<1 || ly>9998 || fm<1 || fm>12 || lm<1 || lm>12 || count<1 || count>12) return null;
  return {start:`${first}-01`, end_exclusive:`${String(lm===12 ? ly+1 : ly).padStart(4,"0")}-${String(lm===12 ? 1 : lm+1).padStart(2,"0")}-01`, count};
}

function ReasonList({items}: {items: Schema["PopulationComparisonReasonV1"][]}) {
  return items.length ? <ul className="comparison-reasons">{Array.from(new Map(items.map(item=>[item.code,item])).values()).map(item=><li key={item.code}>{reasons[item.code] ?? "This source needs further review before a comparison is available. Reload source details or choose another period."}</li>)}</ul> : null;
}

function Result({value, query}: {value: Comparison; query: Query}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();},[]);
  const monthly = value.comparison_basis === "monthly_equivalent";
  return <section className="panel comparison-results" aria-labelledby="comparison-result-heading">
    <h2 id="comparison-result-heading" tabIndex={-1} ref={heading}>{statusLabels[value.status]}</h2>
    <p className="field-hint">{query.start} until {query.end_exclusive} (end excluded) · {value.selection?.cohort?.label ?? "Household group unavailable"}. Calculated {planDate(value.as_of)} (Helsinki).</p>
    <p className="comparison-context">{monthly ? "Monthly context divides your observed net spending by the selected number of months and the survey's annual household mean by 12. Seasons can differ." : "Annual context compares twelve complete observed months with an annual household mean."} The survey describes {value.source?.reference_period ?? "an unavailable year"} prices. No inflation adjustment is applied.</p>
    <ReasonList items={value.reasons}/>
    {value.rows.map(row=><article className="comparison-row" key={row.coicop_code} aria-labelledby={`category-${row.coicop_code}`}>
      <div className="review-account-heading"><h3 id={`category-${row.coicop_code}`}>{row.label}</h3><span className="bank-state">{row.status === "withheld" ? "Comparison withheld" : row.status === "approximate" ? "Approximate context" : "Annual comparison"}</span></div>
      {row.status !== "withheld" && <dl className="comparison-amounts">
        <div><dt>Your observed net spending{monthly ? " per month" : " per year"}</dt><dd>{row.observed_equivalent_minor === null ? "Unavailable" : euros(row.observed_equivalent_minor)}</dd></div>
        <div><dt>{value.source?.reference_period} household mean{monthly ? " ÷ 12" : " per year"}</dt><dd>{row.public_equivalent_minor === null ? "Unavailable" : euros(row.public_equivalent_minor)}</dd></div>
        <div><dt>Difference from the mean</dt><dd>{row.difference_minor === null ? "Unavailable" : `${row.difference_minor>0 ? "+" : ""}${euros(row.difference_minor)}`}</dd></div>
      </dl>}
      {row.status === "withheld" && <><p className="field-hint">Your comparison figures are withheld until the issues below are resolved.</p><ReasonList items={row.reasons.filter(item=>!value.reasons.some(common=>common.code===item.code))}/></>}
      <p className="field-hint">Original {value.source?.reference_period} annual household mean: {row.public_annual_mean_minor === null ? "unavailable or suppressed" : euros(row.public_annual_mean_minor)}.</p>
    </article>)}
    <p className="comparison-context">A mean is an average across surveyed households, not a spending target. These differences do not establish saving capacity or a population rank.</p>
    <details className="plan-evidence"><summary>Source, coverage and calculation details</summary>
      {value.source && <><p>{value.source.attribution}</p><dl className="bank-evidence">
        <div><dt>Original source</dt><dd><a href={value.source.source_url} target="_blank" rel="noreferrer">Statistics Finland · table {value.source.table_id}</a></dd></div>
        <div><dt>Survey reference</dt><dd>{value.source.reference_period} · {value.source.unit}</dd></div>
        <div><dt>Source updated</dt><dd>{value.source_updated_at ? planDate(value.source_updated_at) : "Unavailable"} (Helsinki)</dd></div>
        <div><dt>Snapshot retrieved</dt><dd>{planDate(value.source.retrieved_at)} (Helsinki)</dd></div>
        <div><dt>Licence</dt><dd><a href={value.source.licence_url} target="_blank" rel="noreferrer">CC BY 4.0</a></dd></div>
        <div><dt>Snapshot identity</dt><dd>{value.source.id}</dd></div>
        <div><dt>Source response SHA-256</dt><dd>{value.source.response_sha256}</dd></div>
      </dl></>}
      <dl className="bank-evidence"><div><dt>Household coverage</dt><dd>{value.household_coverage === "user_confirmed" ? "Confirmed by you; not bank-verified" : "Not confirmed"}</dd></div>
        <div><dt>All known accounts in scope</dt><dd>{value.known_owned_scope_complete === null ? "Unavailable" : value.known_owned_scope_complete ? "Yes" : "No"}</dd></div>
        <div><dt>Previously granted bank sources ready</dt><dd>{value.material_bank_sources_complete === null ? "Unavailable" : value.material_bank_sources_complete ? "Yes" : "No"}</dd></div></dl>
      {value.mapping && <>
        <h3>Observed scope</h3><p>{value.mapping.scope.account_ids.length} account(s) · EUR · data version {value.mapping.scope.data_version}. {value.mapping.scope.dataset_coverage === "covered_synthetic_snapshot" ? "Covered synthetic history for this window." : "History coverage needs review."}</p>
        <ul>{(value.mapping.scope.sources ?? []).map(source=><li key={source.account_id}>{source.institution_id} · {source.mode} source · observed {source.observed_at ? planDate(source.observed_at) : "time unavailable"} (Helsinki). History {source.history_from ?? "unknown"} until {source.history_to_exclusive ?? "unknown"} (end excluded).</li>)}</ul>
        {!!value.mapping.scope.unverified_account_ids?.length && <p>{value.mapping.scope.unverified_account_ids.length} account(s) have unverified source history.</p>}
        <h3>Category mapping</h3><p>Mapping {value.mapping.mapping_version} · {value.mapping.classification_version}. Rule SHA-256: <span className="comparison-digest">{value.mapping.policy_sha256}</span></p>
        <dl className="bank-evidence">{([ ["mapped","Assigned to selected categories"], ["ambiguous","Ambiguous categories"], ["excluded","Excluded by mapping policy"], ["unmapped","Unmapped categories"], ["outside_selection","Outside selected categories"] ] as const).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{value.mapping![key].net_minor === undefined ? "Unavailable" : `${euros(value.mapping![key].net_minor!)} net`}</dd></div>)}</dl>
        <ul>{value.mapping.decisions.filter(item=>item.status==="ambiguous" || item.status==="unmapped").map(item=><li key={item.category}>{item.category || "Unknown category"}: {item.reason}</li>)}</ul>
      </>}
      <h3>Calculation and limits</h3><p>{value.transform_version}</p><ul>{[...value.transformations,...value.limitations].map(item=><li key={item}>{item}</li>)}</ul>
    </details>
  </section>;
}

export function PopulationWorkspace({request}: {request: PrivateRequest}) {
  const [context,setContext] = useState<Context|null>(null);
  const [loading,setLoading] = useState(true), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const [household,setHousehold] = useState(""), [first,setFirst] = useState(""), [last,setLast] = useState("");
  const [basis,setBasis] = useState<Query["comparison_basis"]>("monthly_equivalent");
  const [categories,setCategories] = useState<string[]>([]);
  const [coverage,setCoverage] = useState(false), [short,setShort] = useState(false), [older,setOlder] = useState(false);
  const [result,setResult] = useState<{value:Comparison;query:Query}|null>(null);
  const generation = useRef(0);
  const invalidate = () => {generation.current++;setResult(null);setError("");setBusy(false);};
  const load = useCallback(async()=>{
    const epoch=++generation.current;
    setLoading(true);setBusy(false);setContext(null);setResult(null);setError("");
    setHousehold("");setCategories([]);setCoverage(false);setShort(false);setOlder(false);
    try {
      const [cohorts,crosswalk,accounts] = await Promise.all([
        request<Schema["PublicCohortCatalogV1"]>("public/benchmarks/cohorts"),
        request<Schema["PublicCrosswalkContextV1"]>("public/benchmarks/category-crosswalk"),
        request<Schema["AccountWithSourceV1"][]>("accounts/sources"),
      ]);
      if (epoch!==generation.current) return;
      if (!cohorts.available || !cohorts.catalog || !crosswalk.available || !crosswalk.policy || cohorts.catalog.snapshot.id!==crosswalk.policy.snapshot_id)
        throw new Error("Verified population source details are unavailable or incompatible. Reload later; no replacement survey values have been invented.");
      setContext({catalog:cohorts.catalog,policy:crosswalk.policy,accounts});
    } catch(reason) {if (epoch===generation.current && !aborted(reason)) setError(reason instanceof Error && !(reason instanceof PrivateApiError) ? reason.message : failure(reason));}
    finally {if(epoch===generation.current) setLoading(false);}
  },[request]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  const window=monthWindow(first,last);
  const included=context?.accounts.filter(account=>account.included && account.currency==="EUR") ?? [];
  async function compare(event: FormEvent) {
    event.preventDefault();
    if (!context || !window || !household || !categories.length || busy) return;
    const query:Query={household_code:household,reference_period:context.catalog.reference_period,start:window.start,end_exclusive:window.end_exclusive,
      coicop_codes:[...categories],currency:"EUR",comparison_basis:basis,household_coverage_confirmed:coverage,allow_short_period_approximation:short,allow_reference_year_mismatch:older};
    const epoch=++generation.current;setBusy(true);setResult(null);setError("");
    try {const value=await request<Comparison>("benchmarks/comparison",query);if(epoch===generation.current) setResult({value,query});}
    catch(reason) {if(epoch===generation.current && !aborted(reason)) setError(failure(reason));}
    finally {if(epoch===generation.current) setBusy(false);}
  }
  return <>
    <div className="page-heading"><div><h1>Your spending, in context.</h1><p>Compare a reviewed spending window with Finland&apos;s household consumption survey.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>Synthetic personal spending · Real Statistics Finland survey. Private figures stay within Money Coach.</span></p>
    {loading && <p className="loading-state" role="status">Loading comparison sources…</p>}
    {error && <div className="error-notice comparison-error" role="alert"><span>{error}</span><button onClick={()=>void load()}>Reload source details</button><a href="/banks">Review bank connections</a></div>}
    {context && <>
      <form className="panel review-panel comparison-form" onSubmit={event=>void compare(event)} onChangeCapture={invalidate}>
        <h2>Choose your comparison</h2><p className="field-hint">Historical survey: {context.catalog.reference_period} household means at that year&apos;s prices. This is a dated reference, not a live picture of Finnish spending.</p>
        <label className="plan-field">Household group<select value={household} onChange={event=>setHousehold(event.target.value)} required><option value="">Choose a household group</option>{context.catalog.cohorts.map(item=><option key={item.code} value={item.code}>{item.label}{item.specificity==="all_households" ? " (all households)" : ""}</option>)}</select></label>
        <p className="field-hint">{household && <>Selected: <strong>{context.catalog.cohorts.find(item=>item.code===household)?.label}</strong>. </>}Choose the group yourself. We do not infer your household from transactions or substitute a broader group.</p>
        <div className="plan-fields"><label className="plan-field">First month<input type="month" value={first} required aria-describedby="comparison-period-hint" onChange={event=>setFirst(event.target.value)}/></label><label className="plan-field">Last month (included)<input type="month" value={last} required aria-describedby="comparison-period-hint" onChange={event=>setLast(event.target.value)}/></label></div>
        <p className="field-hint" id="comparison-period-hint">Use 1–12 complete calendar months. Pending transactions are excluded; booked refunds reduce spending.</p>
        {first && last && !window && <p className="bank-source-warning" role="alert">Choose consecutive months in order, with no more than twelve months in total.</p>}
        <label className="plan-field">Comparison basis<select value={basis} onChange={event=>setBasis(event.target.value as Query["comparison_basis"])}><option value="monthly_equivalent">Approximate monthly context</option><option value="annual_observed">Twelve-month annual observation</option></select></label>
        <p className="field-hint">{basis==="monthly_equivalent" ? "Monthly context: your observed spending per month against the annual survey mean divided by twelve." : "Annual observation: twelve complete observed months against the annual survey mean."}</p>
        <fieldset aria-describedby="comparison-category-hint"><legend>Categories to compare</legend><p className="field-hint" id="comparison-category-hint">Choose one or more. A broad group and its subgroups cannot be compared together; clear the selected group to choose its alternative.</p>
          {context.policy.targets.map(target=>{
            const overlap=categories.some(code=>code!==target.code && (code.startsWith(target.code) || target.code.startsWith(code)));
            return <label className="check-field" key={target.code}><input type="checkbox" checked={categories.includes(target.code)} disabled={overlap} onChange={event=>setCategories(value=>event.target.checked ? [...value,target.code] : value.filter(code=>code!==target.code))}/><span>{target.label}{overlap && <small className="bank-account-meta">Overlaps a selected category</small>}</span></label>;
          })}
        </fieldset>
        <fieldset><legend>Review the scope and limitations</legend><p className="field-hint">Uses all included EUR accounts: {included.length ? included.map(account=>account.name).join(", ") : "none included"}. Excluded or missing accounts can prevent a household comparison.</p>
          <details><summary>Review account and public source details</summary><ul>{context.accounts.map(account=><li key={account.id}>{account.name} · {account.currency} · {account.included ? "included" : "excluded"}. {account.source ? `${account.source.mode} source · ${account.source.granted ? "access granted" : "access required"} · observed ${account.source.observed_at ? planDate(account.source.observed_at) : "time unavailable"} (Helsinki).` : "Source history is unverified."}</li>)}</ul><p>{context.catalog.snapshot.attribution}</p><p>Retrieved {planDate(context.catalog.snapshot.retrieved_at)} (Helsinki). <a href={context.catalog.snapshot.source_url} target="_blank" rel="noreferrer">View original table</a> · <a href={context.catalog.snapshot.licence_url} target="_blank" rel="noreferrer">CC BY 4.0</a>.</p></details>
          <p className="field-hint"><a href="/banks">Review bank connections</a> before confirming household coverage. Bank account coverage alone cannot verify household expenses.</p>
          <label className="check-field"><input type="checkbox" checked={coverage} onChange={event=>setCoverage(event.target.checked)}/><span>I confirm these accounts cover the household&apos;s expenses for this period, including any other banks and cash.</span></label>
          <label className="check-field"><input type="checkbox" checked={short} onChange={event=>setShort(event.target.checked)}/><span>I accept that fewer than twelve months provide approximate monthly context and may be affected by seasons.</span></label>
          <label className="check-field"><input type="checkbox" checked={older} onChange={event=>setOlder(event.target.checked)}/><span>I accept the {context.catalog.reference_period} price reference for spending in a different year, without inflation adjustment.</span></label>
        </fieldset>
        <div className="plan-actions"><button className="primary-button" disabled={busy || !household || !window || !categories.length}>{busy ? "Comparing…" : "Compare selected categories"}</button><button className="text-button" type="button" onClick={()=>void load()}>Reload source details</button></div>
        <p className="field-hint comparison-submit-hint" role="status">{busy ? "Checking source coverage and category compatibility…" : "Missing confirmations return reasons for withholding a comparison. No settings or household choices are saved."}</p>
      </form>
      {result && <Result key={generation.current} value={result.value} query={result.query}/>}
    </>}
  </>;
}
