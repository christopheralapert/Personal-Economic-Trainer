"use client";

import {useCallback,useEffect,useRef,useState} from "react";
import type {components} from "@contracts";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {CoachingPreferencesForm,type CoachingFields} from "./coaching-preferences-form";
import {euros,planDate} from "./plan-format";

type Schema=components["schemas"];
type Preferences=Schema["CoachingPreferencesViewV1"];
type Page=Schema["InsightPageV1"];
type Insight=Schema["InsightViewV1"];
type Job=Schema["JobStatusView"];
type Command={path:string;body:object;kind:"preferences"|"dismiss"|"refresh";message:string};
const messages:Record<string,string>={
  COACHING_VERSION_CHANGED:"Your preferences changed in another request. Reload coaching before making another change.",
  INSIGHT_VERSION_CHANGED:"This notice changed in another request. Reload coaching before dismissing it.",
  COACHING_NOT_ENABLED:"Enable coaching notices and save your preferences before requesting a refresh.",
  CURSOR_SCOPE_CHANGED:"Your notice list changed. Reload coaching before loading more notices.",
  CURSOR_EXPIRED:"This notice list has expired. Reload coaching to continue.",
  INSIGHT_ALREADY_DISMISSED:"This notice was already dismissed. Reload coaching to see its history.",
  INSIGHT_REFRESH_THROTTLED:"The refresh limit has been reached. Wait one hour before requesting a new refresh.",
  COACHING_COMMAND_THROTTLED:"Too many preference changes were made recently. Wait one hour before making another change.",
  INSIGHT_COMMAND_THROTTLED:"Too many notices were dismissed recently. Wait one hour before dismissing another notice.",
  NOT_FOUND:"This notice is no longer available to your profile. Reload coaching.",
};
const blockers:Record<string,string>={
  INSIGHT_NOT_ACTIVE:"This notice is retained history.",INSIGHT_EVIDENCE_EXPIRED:"The recorded source check has expired.",
  INSIGHT_CONTEXT_CHANGED:"The data, plan, preferences or access changed after this notice was generated.",
  COACHING_DISABLED_PAUSED_OR_KIND_DISABLED:"Coaching or this notice type is off, or generation is paused.",
};
const failure=(reason:unknown)=>reason instanceof PrivateApiError ? messages[reason.code]??reason.message : "Coaching information is unavailable. Check your connection and reload coaching.";
const money=(value:number,currency:string)=>currency==="EUR" ? euros(value) : `${value.toLocaleString("en-GB")} minor units (${currency})`;
const date=(value:string)=>new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",day:"numeric",month:"short",year:"numeric"}).format(new Date(`${value}T00:00:00Z`));
const definite=(reason:unknown)=>reason instanceof PrivateApiError && (reason.code.startsWith("COACHING_")||reason.code.startsWith("INSIGHT_")||["NOT_FOUND","INVALID_REQUEST","INVALID_COACHING_PREFERENCES","INVALID_COACHING_PAUSE","INVALID_INSIGHT_COMMAND","IDEMPOTENCY_CONFLICT"].includes(reason.code));
const expire=<T extends Page["rows"][number]|Insight,>(row:T,now:number):T=>row.current && Date.parse(row.expires_at)<=now ? {...row,current:false,current_blockers:[...row.current_blockers,"INSIGHT_EVIDENCE_EXPIRED"]} : row;

function InsightEvidence({insight}:{insight:Insight}) {
  const evidence=insight.evidence,candidate=insight.candidate;
  return <details className="plan-evidence"><summary>Recorded sources and calculation details</summary>
    <p>These figures describe the recorded rule snapshot. Open your reviewed plan for a fresh spending or savings decision.</p>
    <dl className="plan-breakdown"><div><dt>{candidate.kind==="upcoming_bill" ? "Recorded bill amount" : candidate.kind==="low_headroom" ? "Recorded lowest projected headroom" : "Recorded increase in observed spending"}</dt><dd>{money(candidate.amount_minor,candidate.currency)}</dd></div>
      {candidate.baseline_minor!=null && <div><dt>Recorded comparison baseline</dt><dd>{money(candidate.baseline_minor,candidate.currency)}</dd></div>}
      {candidate.at && <div><dt>{candidate.kind==="upcoming_bill" ? "Recorded bill due" : "Recorded projection time"}</dt><dd>{planDate(candidate.at)} (Helsinki)</dd></div>}
    </dl>
    {candidate.account_id && <p className="field-hint">This notice concerns one account in its recorded scope. Its amount may differ from your combined accounts.</p>}
    {"planning" in evidence ? <>
      <p>Planning input recorded {planDate(evidence.planning.input_as_of)} (Helsinki). {evidence.planning.source==="synthetic_user_confirmed" ? "Synthetic, user-confirmed planning inputs." : "Verified planning inputs."}</p>
      {candidate.kind==="upcoming_bill" && evidence.policy.bill_lookahead_calendar_days!==undefined && <p>This rule looks ahead {evidence.policy.bill_lookahead_calendar_days} Helsinki calendar days and also includes overdue reviewed bills.</p>}
      {candidate.kind==="low_headroom" && evidence.policy.low_headroom_threshold_minor!==undefined && <p>This rule flags projected headroom at or below {euros(evidence.policy.low_headroom_threshold_minor)}. That threshold is a review prompt, not a personal spending limit.</p>}
      <p>{evidence.planning.account_ids.length} account(s), {evidence.planning.balance_snapshot_ids.length} balance snapshot(s). Rule: {evidence.policy.version}.</p>
      {(evidence.omitted_candidate_count??0)>0 && <p>{evidence.omitted_candidate_count} other rule candidates were outside this batch limit.</p>}
    </> : <>
      <dl className="plan-breakdown"><div><dt>Observed period</dt><dd>{date(evidence.comparison.current.scope.start)} to {date(evidence.comparison.current.scope.end_exclusive)} (end excluded)</dd></div>
        <div><dt>Baseline period</dt><dd>{date(evidence.comparison.baseline.scope.start)} to {date(evidence.comparison.baseline.scope.end_exclusive)} (end excluded)</dd></div>
        <div><dt>Recorded observed net spending</dt><dd>{euros(evidence.comparison.current.net_minor)}</dd></div>
        <div><dt>Recorded baseline net spending</dt><dd>{euros(evidence.comparison.baseline.net_minor)}</dd></div>
        <div><dt>Expense transactions, observed / baseline</dt><dd>{evidence.comparison.frequency.current_expense_count} / {evidence.comparison.frequency.baseline_expense_count}</dd></div></dl>
      <p>Only the accounts and covered booking dates in this recorded comparison were included. Net spending subtracts recorded refunds. It is not a forecast or a judgment about your habits.</p>
      {evidence.policy.spending_increase_basis_points!==undefined && evidence.policy.spending_minimum_increase_minor!==undefined && <p>This rule requires an increase of at least {evidence.policy.spending_increase_basis_points/100}% and {euros(evidence.policy.spending_minimum_increase_minor)}, with at least {evidence.policy.spending_minimum_expense_count} expense transactions in each period and a baseline of at least {evidence.policy.spending_minimum_baseline_minor!==undefined ? euros(evidence.policy.spending_minimum_baseline_minor) : "the recorded minimum"}.</p>}
      {evidence.comparison.limitations.map((item,index)=><p key={index}>{item}</p>)}
    </>}
    <ul>{candidate.assumptions.map((item,index)=><li key={index}>{item}</li>)}</ul>
    <p>Generated {planDate(insight.generated_at)}; source check expires {planDate(insight.expires_at)} (Helsinki). Data version {insight.data_version}; plan {insight.plan_version}; preferences {insight.preferences_version}; notice {insight.version}.</p>
  </details>;
}

export function CoachingWorkspace({request,changed}:{request:PrivateRequest;changed:()=>void}) {
  const [preferences,setPreferences]=useState<Preferences|null>(null),[page,setPage]=useState<Page|null>(null);
  const [status,setStatus]=useState<"active"|"superseded"|"dismissed">("active");
  const [insight,setInsight]=useState<Insight|null>(null),[job,setJob]=useState<Job|null>(null);
  const [polls,setPolls]=useState(0),[pollError,setPollError]=useState("");
  const [reloadSignal,setReloadSignal]=useState(0);
  const [loading,setLoading]=useState(true),[detailLoading,setDetailLoading]=useState(false),[busy,setBusy]=useState(false);
  const [pending,setPending]=useState<Command|null>(null),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const alive=useRef(true),readEpoch=useRef(0),detailEpoch=useRef(0),jobEpoch=useRef(0),lock=useRef(false),clock=useRef({server:0,read:0});
  const heading=useRef<HTMLHeadingElement>(null);
  const locked=busy||pending!==null,refreshing=job!==null && ["queued","running"].includes(job.state);
  const load=useCallback(async()=>{
    const epoch=++readEpoch.current;++detailEpoch.current;
    const started=performance.now();
    setLoading(true);setPage(null);setPreferences(null);setInsight(null);setDetailLoading(false);setError("");
    try {
      const [prefs,result]=await Promise.all([request<Preferences>("coaching/preferences"),request<Page>(`insights?status=${status}&limit=50`)]);
      if(prefs.version!==result.preferences_version) throw new Error("Preferences changed while loading. Reload coaching to read the current choices.");
      if(alive.current && epoch===readEpoch.current) {
        clock.current={server:Date.parse(result.as_of),read:started};
        const now=clock.current.server+(performance.now()-started);
        setPreferences(prefs);setPage({...result,rows:result.rows.map(row=>expire(row,now))});
      }
    } catch(reason) {if(alive.current && epoch===readEpoch.current && !aborted(reason)) setError(reason instanceof PrivateApiError ? failure(reason) : (reason as Error).message);}
    finally {if(alive.current && epoch===readEpoch.current) setLoading(false);}
  },[request,status]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;readEpoch.current++;detailEpoch.current++;};},[load,reloadSignal]);
  useEffect(()=>()=>{jobEpoch.current++;},[]);
  useEffect(()=>{if(insight && !detailLoading) heading.current?.focus();},[insight?.id,detailLoading]);
  useEffect(()=>{
    if(!page) return;
    const current=[...page.rows,...(insight ? [insight] : [])].filter(row=>row.current);
    if(!current.length) return;
    const remaining=Math.min(...current.map(row=>Date.parse(row.expires_at)))-clock.current.server-(performance.now()-clock.current.read);
    const timer=window.setTimeout(()=>{
      const now=clock.current.server+(performance.now()-clock.current.read);
      setPage(old=>old ? {...old,rows:old.rows.map(row=>expire(row,now))} : null);setInsight(old=>old ? expire(old,now) : null);
    },Math.min(2147483647,Math.max(0,remaining)+20));
    return()=>window.clearTimeout(timer);
  },[page,insight]);

  const checkJob=useCallback(async(id:string)=>{
    const epoch=++jobEpoch.current;
    try {
      const next=await request<Job>(`jobs/${id}`);
      if(!alive.current || epoch!==jobEpoch.current) return;
      setJob(next);setPollError("");setPolls(value=>value+1);
      if(next.state==="completed") {setNotice("Refresh completed. Current sources may produce no notices; review any available results below.");changed();setReloadSignal(value=>value+1);}
      else if(["failed","cancelled","dead_letter"].includes(next.state)) setPollError("The refresh did not complete. Reload coaching and review your sources before requesting another refresh.");
    } catch(reason) {if(alive.current && epoch===jobEpoch.current && !aborted(reason)) {setPollError("Refresh status is unavailable. Check the existing refresh before requesting another one.");setPolls(20);}}
  },[request,changed]);
  useEffect(()=>{
    if(!job || !["queued","running"].includes(job.state) || polls>=20 || pending) return;
    const timer=window.setTimeout(()=>void checkJob(job.id),3000);
    return()=>window.clearTimeout(timer);
  },[job,polls,pending,checkJob]);

  const execute=async(command:Command)=>{
    if(lock.current) return;
    lock.current=true;setBusy(true);setPending(command);setError("");setNotice("");
    readEpoch.current++;detailEpoch.current++;setPage(null);setPreferences(null);setInsight(null);setDetailLoading(false);
    try {
      const receipt=await request<Job|Schema["CoachingCommandReceiptV1"]|Schema["InsightCommandReceiptV1"]>(command.path,command.body);
      if(!alive.current) return;
      setPending(null);setNotice(command.message);changed();
      if(command.kind==="refresh") {jobEpoch.current++;setJob(receipt as Job);setPolls(0);setPollError("");}
      await load();
      if(command.kind==="refresh" && (receipt as Job).state==="completed") setNotice("This refresh already completed. Review the freshly loaded notices below.");
    } catch(reason) {
      if(alive.current && !aborted(reason)) {
        setError(failure(reason));if(definite(reason)) setPending(null);
      }
    } finally {lock.current=false;if(alive.current) setBusy(false);}
  };
  const savePreferences=async(fields:CoachingFields|null,pause?:24|null)=>{
    if(!preferences || locked || lock.current) return;
    lock.current=true;setBusy(true);setError("");
    try {
      const fresh=await request<Preferences>("coaching/preferences");
      if(!alive.current) return;
      if(fresh.version!==preferences.version) {setPage(null);setPreferences(null);setInsight(null);setError(messages.COACHING_VERSION_CHANGED);return;}
      const pausedUntil=pause===24 ? new Date(Date.parse(fresh.as_of)+24*60*60*1000).toISOString() : pause===null ? null : fresh.state.paused ? fresh.paused_until : null;
      const choices=fields??{coaching_enabled:fresh.coaching_enabled,bill_insights:fresh.bill_insights,headroom_insights:fresh.headroom_insights,spending_insights:fresh.spending_insights,timezone:fresh.timezone??"Europe/Helsinki",quiet_start:fresh.quiet_start??null,quiet_end:fresh.quiet_end??null};
      lock.current=false;
      await execute({path:"coaching/preferences",kind:"preferences",body:{...choices,paused_until:pausedUntil,delivery_mode:"in_app_only",key:crypto.randomUUID(),expected_preferences_version:fresh.version},message:pause===24 ? "Coaching generation paused for 24 hours." : pause===null ? "Coaching pause cleared." : "Coaching preferences saved. Existing history is retained."});
    } catch(reason) {if(alive.current && !aborted(reason)) setError(failure(reason));}
    finally {lock.current=false;if(alive.current) setBusy(false);}
  };
  const open=async(id:string)=>{
    if(locked) return;
    const epoch=++detailEpoch.current;setInsight(null);setDetailLoading(true);setError("");
    try {
      const result=await request<Insight>(`insights/${id}`);
      if(alive.current && epoch===detailEpoch.current) setInsight(expire(result,clock.current.server+(performance.now()-clock.current.read)));
    } catch(reason) {if(alive.current && epoch===detailEpoch.current && !aborted(reason)) setError(failure(reason));}
    finally {if(alive.current && epoch===detailEpoch.current) setDetailLoading(false);}
  };
  const more=async()=>{
    if(!page?.next_cursor || locked || lock.current) return;
    const epoch=readEpoch.current;lock.current=true;setBusy(true);setError("");
    try {
      const next=await request<Page>(`insights?status=${status}&limit=50&cursor=${encodeURIComponent(page.next_cursor)}`);
      if(alive.current && epoch===readEpoch.current) setPage({...next,rows:[...page.rows,...next.rows].map(row=>expire(row,clock.current.server+(performance.now()-clock.current.read)))});
    } catch(reason) {if(alive.current && epoch===readEpoch.current && !aborted(reason)) {setPage(null);setInsight(null);setError(failure(reason));}}
    finally {lock.current=false;if(alive.current) setBusy(false);}
  };
  return <>
    <div className="page-heading"><div><h1>Your coaching notices</h1><p>Spot upcoming costs and changes in your recorded spending. Choose what deserves a closer look.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>Rule-based notices explain recorded evidence. They do not reserve money or grant spending permission.</span></p>
    <div className="plan-actions coaching-toolbar"><button className="primary-button" disabled={locked||loading||refreshing||!preferences?.state.generation_active} onClick={()=>void execute({path:"insights/refresh",kind:"refresh",body:{key:crypto.randomUUID()},message:"Refresh requested. Notices appear only after the worker checks current sources."})}>Refresh notices</button>
      <button className="secondary-button" disabled={locked} onClick={()=>void load()}>Reload coaching</button><a href="/plan">Review your spending plan</a></div>
    <p className="bank-feedback" role="status">{notice}</p>
    {error && <p className="error-notice" role="alert">{error}</p>}
    {pending && !busy && <div className="plan-blockers"><p>The change could not be confirmed. Other changes are locked until you check this exact request.</p><button className="secondary-button" onClick={()=>void execute(pending)}>Retry the same coaching request</button></div>}
    {job && <div className="coaching-job" role="status"><p>Refresh {job.state==="dead_letter" ? "stopped after its retry limit" : job.state}. {refreshing ? "Keep this view open for status checks. No new refresh is sent automatically." : ""}</p>
      {pollError && <p>{pollError}</p>}{refreshing && <button className="secondary-button" disabled={locked} onClick={()=>{setPolls(0);void checkJob(job.id);}}>Check refresh status</button>}</div>}
    {loading && <p role="status" className="loading-state">Loading your owned coaching information…</p>}
    {!loading && !pending && preferences && <>
      {!preferences.coaching_enabled ? <p className="coaching-state">Coaching is off. Enable notices in your preferences to request a source review.</p> : preferences.state.paused ? <p className="coaching-state">Coaching generation is paused. Your owned history remains available.</p> : <p className="coaching-state">Coaching is enabled. Refresh checks your selected notice types against current sources.</p>}
      <CoachingPreferencesForm key={preferences.version} preferences={preferences} locked={locked} save={fields=>void savePreferences(fields)} pause={hours=>void savePreferences(null,hours)}/>
    </>}
    {!loading && !pending && page && <section className="panel coaching-section" aria-labelledby="notice-list-heading">
      <div className="goal-list-heading"><h2 id="notice-list-heading">Your notices</h2><label className="plan-field">Show notices<select disabled={locked} value={status} onChange={event=>setStatus(event.target.value as typeof status)}><option value="active">Open</option><option value="superseded">Previous</option><option value="dismissed">Dismissed</option></select></label></div>
      {!page.rows.length ? <p className="bank-empty">No {status==="active" ? "open" : status==="superseded" ? "previous" : "dismissed"} notices in this view. A completed refresh may have no eligible results when sources need review or no rule applies.</p> : <ul className="insight-list">{page.rows.map(row=><li key={row.id}><div><h3>{row.candidate.title}</h3><p>{row.candidate.reason}</p><p className="bank-state">{row.current ? "Source check passed when loaded" : "Needs a fresh review"} · {row.status==="superseded" ? "Previous" : row.status==="dismissed" ? "Dismissed" : "Open"}</p></div><button className="secondary-button" disabled={locked} aria-label={`Review ${row.candidate.title}`} onClick={()=>void open(row.id)}>Review notice</button></li>)}</ul>}
      {page.next_cursor && <button className="text-button" disabled={locked} onClick={()=>void more()}>Load more notices</button>}
      <p className="field-hint">Loaded {planDate(page.as_of)} (Helsinki). Open notices can still require a fresh review. Previous and dismissed notices are retained history.</p>
    </section>}
    {detailLoading && <p role="status">Loading recorded notice evidence…</p>}
    {!pending && insight && <section className="panel coaching-section insight-detail" aria-labelledby="notice-detail-heading"><h2 id="notice-detail-heading" ref={heading} tabIndex={-1}>{insight.candidate.title}</h2>
      <p>{insight.candidate.reason}</p><p className="field-hint">Recorded rule snapshot. {insight.current ? "Its source check passed when loaded; review your plan before acting." : "Needs a fresh review. These figures are historical."}</p>
      {!insight.current && <ul className="coaching-reasons">{insight.current_blockers.map((code,index)=><li key={index}>{blockers[code]??"A current source or access check is required before using this notice."}</li>)}</ul>}
      <InsightEvidence insight={insight}/>
      <div className="plan-actions">{insight.candidate.action==="review_plan" && <a href="/plan">Review your spending plan</a>}
        <button className="secondary-button" disabled={locked||insight.status==="dismissed"} onClick={()=>void execute({path:`insights/${insight.id}/dismiss`,kind:"dismiss",body:{key:crypto.randomUUID(),expected_insight_version:insight.version},message:"Notice dismissed. Its recorded history is still available under Dismissed."})}>Dismiss notice</button>
        <button className="text-button" disabled={locked} onClick={()=>{detailEpoch.current++;setInsight(null);}}>Close notice</button></div>
    </section>}
  </>;
}
