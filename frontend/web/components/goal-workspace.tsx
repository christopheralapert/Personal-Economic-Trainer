"use client";

import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import type {components} from "@contracts";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {euros,parseEuro,planDate} from "./plan-format";

type Schema=components["schemas"];
type Goal=Schema["GoalViewV1"];
type Page=Schema["GoalPageV1"];
type Assignments=Schema["GoalAllocationPageV1"];
type Command={path:string;body:object;message:string};
type Receipt=Schema["GoalCommandReceiptV1"]|Schema["GoalAllocationCommandReceiptV1"];
const money=(value:number,currency:string)=>currency==="EUR" ? euros(value) : `${value.toLocaleString("en-GB")} minor units (${currency})`;
const day=(value:string)=>new Intl.DateTimeFormat("en-GB",{timeZone:"UTC",day:"numeric",month:"short",year:"numeric"}).format(new Date(`${value}T00:00:00Z`));
const messages:Record<string,string>={
  GOAL_VERSION_CHANGED:"This goal changed in another request. Reload goals before making another change.",
  CURSOR_SCOPE_CHANGED:"The information changed while loading more rows. Reload goals to read a consistent list.",
  CURSOR_EXPIRED:"This list has expired. Reload goals before loading more rows.",
  GOAL_ALLOCATION_ALREADY_LINKED:"This reservation already belongs to a goal. Unlink it from that goal first, keeping the money reserved.",
  GOAL_ALLOCATION_REVIEW_REQUIRED:"This goal still has active reservations. Unlink them with Keep money reserved, or release them from your reviewed plan, before removing the goal.",
  GOAL_RESERVATION_RECONCILIATION_REQUIRED:"This reservation needs reconciliation. Its currency, amount or saved movement cannot be confirmed. Review the reservation in your plan.",
  GOAL_ALLOCATION_NOT_ACTIVE:"This reservation has been released. Reload goals and choose an active reservation.",
  GOAL_NOT_ACTIVE:"Activate the goal before linking a reservation.",
  GOAL_REMOVED:"This goal was removed. Reload goals to see its retained history.",
  GOAL_COMMAND_THROTTLED:"Too many goal changes were made recently. Wait one hour before trying a new change.",
  GOAL_LIMIT_REACHED:"The retained goal limit has been reached. Existing goals can still be reviewed.",
  GOAL_ALLOCATION_LIMIT_REACHED:"This goal has reached its reservation history limit. Review its existing reservations.",
  NOT_FOUND:"This goal or reservation is no longer available to your profile. Reload goals.",
};
const failure=(reason:unknown)=>reason instanceof PrivateApiError ? messages[reason.code]??reason.message : "The request could not be confirmed. Check your connection and try again.";

function GoalForm({goal,locked,submit,cancel}:{goal:Goal|null;locked:boolean;submit:(fields:object)=>void;cancel:()=>void}) {
  const [name,setName]=useState(goal?.name??"");
  const [target,setTarget]=useState(goal ? `${Math.floor(goal.target_minor/100)}.${String(goal.target_minor%100).padStart(2,"0")}` : "");
  const [deadline,setDeadline]=useState(goal?.deadline??"");
  const [priority,setPriority]=useState(goal?.priority??3);
  const [error,setError]=useState("");
  const heading=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{heading.current?.focus();},[]);
  const save=(event:FormEvent)=>{
    event.preventDefault();setError("");
    try {
      const amount=parseEuro(target);
      if (!amount) throw new Error("Choose a target greater than zero.");
      if (!name.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw new Error("Choose a nonblank single-line goal name.");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) throw new Error("Choose a calendar deadline.");
      submit({name:name.trim(),target_minor:amount,currency:"EUR",deadline,priority});
    } catch(reason) {setError((reason as Error).message);}
  };
  return <section className="panel review-panel goal-section" aria-labelledby="goal-form-heading">
    <h2 id="goal-form-heading" ref={heading} tabIndex={-1}>{goal ? "Edit your goal" : "Add a savings goal"}</h2>
    <p className="field-hint">A target is an intention. Saving a goal does not reserve or transfer money.</p>
    <form onSubmit={save}><fieldset disabled={locked}>
      <label className="plan-field">Goal name<input autoComplete="off" required maxLength={120} value={name} onChange={event=>setName(event.target.value)}/></label>
      <div className="plan-fields"><label className="plan-field">Target (EUR)<input inputMode="decimal" autoComplete="off" required value={target} onChange={event=>setTarget(event.target.value)}/></label>
        <label className="plan-field">Deadline<input type="date" required value={deadline} onChange={event=>setDeadline(event.target.value)}/></label></div>
      <label className="plan-field">Priority<select value={priority} onChange={event=>setPriority(Number(event.target.value))}>{[1,2,3,4,5].map(value=><option key={value} value={value}>{value===1 ? "1 · Highest" : value===3 ? "3 · Normal" : value===5 ? "5 · Lowest" : String(value)}</option>)}</select></label>
      <p className="field-hint">Past deadlines stay visible as past. We do not assume your income can fund the target.</p>
      {error && <p className="error-notice" role="alert">{error}</p>}
      <div className="plan-actions"><button className="primary-button" type="submit">{goal ? "Save goal changes" : "Create goal"}</button><button className="text-button" type="button" onClick={cancel}>Cancel editing</button></div>
    </fieldset></form>
  </section>;
}

export function GoalWorkspace({request,changed}:{request:PrivateRequest;changed:()=>void}) {
  const [page,setPage]=useState<Page|null>(null);
  const [state,setState]=useState("");
  const [goal,setGoal]=useState<Goal|null>(null);
  const [assignments,setAssignments]=useState<Assignments|null>(null);
  const [candidatePage,setCandidatePage]=useState<Schema["AllocationPageV1"]|null>(null);
  const [planId,setPlanId]=useState<string|null>(null);
  const [selectedAllocation,setSelectedAllocation]=useState("");
  const [editing,setEditing]=useState<"create"|"edit"|null>(null);
  const [removing,setRemoving]=useState(false);
  const [loading,setLoading]=useState(true);
  const [detailLoading,setDetailLoading]=useState(false);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<Command|null>(null);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const alive=useRef(true),epoch=useRef(0),listEpoch=useRef(0),lock=useRef(false);
  const goalHeading=useRef<HTMLHeadingElement>(null);
  const locked=busy||pending!==null;

  const clearDetail=()=>{setGoal(null);setAssignments(null);setCandidatePage(null);setPlanId(null);setSelectedAllocation("");setRemoving(false);setDetailLoading(false);};
  const load=useCallback(async()=>{
    const version=++listEpoch.current;++epoch.current;
    setLoading(true);setPage(null);setGoal(null);setAssignments(null);setCandidatePage(null);setPlanId(null);setSelectedAllocation("");setEditing(null);setRemoving(false);setDetailLoading(false);setError("");
    try {
      const result=await request<Page>(`goals?limit=50${state ? `&state=${state}` : ""}`);
      if (alive.current && version===listEpoch.current) setPage(result);
    } catch(reason) {if (alive.current && version===listEpoch.current && !aborted(reason)) setError(failure(reason));}
    finally {if (alive.current && version===listEpoch.current) setLoading(false);}
  },[request,state]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;epoch.current++;listEpoch.current++;};},[load]);
  useEffect(()=>{if(goal && !detailLoading) goalHeading.current?.focus();},[goal?.id,detailLoading]);

  const open=async(id:string)=>{
    const version=++epoch.current;clearDetail();setEditing(null);setDetailLoading(true);setError("");
    try {
      const result=await request<Goal>(`goals/${id}`);
      const history=await request<Assignments>(`goals/${id}/allocations?limit=50`);
      if (history.goal_version!==result.version || history.collection_version!==result.collection_version || history.plan_version!==result.plan_version || history.data_version!==result.data_version)
        throw new Error("Goal information changed while loading. Reload goals to review its current state.");
      if (alive.current && version===epoch.current) {setGoal(result);setAssignments(history);}
    } catch(reason) {if (alive.current && version===epoch.current && !aborted(reason)) setError(reason instanceof PrivateApiError ? failure(reason) : (reason as Error).message);}
    finally {if (alive.current && version===epoch.current) setDetailLoading(false);}
  };

  const execute=async(command:Command)=>{
    if(lock.current) return;
    lock.current=true;setBusy(true);setPending(command);setError("");setNotice("");setGoal(null);setAssignments(null);setEditing(null);setCandidatePage(null);setDetailLoading(false);epoch.current++;
    try {
      const receipt=await request<Receipt>(command.path,command.body);
      if(!alive.current) return;
      setPending(null);setNotice(command.message);changed();
      await load();await open(receipt.goal.id);
    } catch(reason) {
      if(alive.current && !aborted(reason)) {
        setError(failure(reason));
        if(reason instanceof PrivateApiError && (reason.code.startsWith("GOAL_") || ["NOT_FOUND","INVALID_REQUEST","IDEMPOTENCY_CONFLICT","CURSOR_SCOPE_CHANGED"].includes(reason.code))) setPending(null);
      }
    } finally {lock.current=false;if(alive.current) setBusy(false);}
  };
  const command=(action:string,message:string,extra:object={})=>{
    if(!goal) return;
    void execute({path:`goals/${goal.id}/${action}`,body:{key:crypto.randomUUID(),expected_goal_version:goal.version,...extra},message});
  };

  const moreGoals=async()=>{
    if(!page?.next_cursor || locked) return;
    const version=listEpoch.current;setBusy(true);setError("");
    try {
      const next=await request<Page>(`goals?limit=50${state ? `&state=${state}` : ""}&cursor=${encodeURIComponent(page.next_cursor)}`);
      if(alive.current && version===listEpoch.current) setPage({...next,rows:[...page.rows,...next.rows]});
    } catch(reason) {if(alive.current && !aborted(reason)) {setPage(null);setError(failure(reason));}}
    finally {if(alive.current) setBusy(false);}
  };
  const reservations=async(more=false)=>{
    if(!goal || locked) return;
    const version=epoch.current;setBusy(true);setError("");
    try {
      let id=planId;
      if(!id) {const plan=await request<Schema["PlanViewV1"]|null>("plans/current");id=plan?.id??null;}
      if(!id) {if(alive.current && version===epoch.current) setNotice("No reviewed plan is saved. Open your reviewed plan to create and accept a reservation first.");return;}
      const result=await request<Schema["AllocationPageV1"]>(`plans/${id}/allocations?limit=50${more && candidatePage?.next_cursor ? `&cursor=${encodeURIComponent(candidatePage.next_cursor)}` : ""}`);
      if(alive.current && version===epoch.current) {setPlanId(id);setCandidatePage({...result,rows:more && candidatePage ? [...candidatePage.rows,...result.rows] : result.rows});setSelectedAllocation("");}
    } catch(reason) {if(alive.current && version===epoch.current && !aborted(reason)) {setCandidatePage(null);setError(failure(reason));}}
    finally {if(alive.current) setBusy(false);}
  };
  const moreAssignments=async()=>{
    if(!goal || !assignments?.next_cursor || locked) return;
    const version=epoch.current;setBusy(true);setError("");
    try {
      const next=await request<Assignments>(`goals/${goal.id}/allocations?limit=50&cursor=${encodeURIComponent(assignments.next_cursor)}`);
      if(alive.current && version===epoch.current) setAssignments({...next,rows:[...assignments.rows,...next.rows]});
    } catch(reason) {if(alive.current && version===epoch.current && !aborted(reason)) {setGoal(null);setAssignments(null);setError(failure(reason));}}
    finally {if(alive.current) setBusy(false);}
  };
  const choices=candidatePage?.rows.filter(item=>item.state==="active" && item.currency===goal?.currency && !assignments?.rows.some(link=>link.id===item.id))??[];

  return <>
    <div className="page-heading"><div><h1>Give your savings a purpose.</h1><p>Set a target, link money you already reserved, and see what still needs funding.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>Goals do not move money. Reservations are earmarks; actual saved progress is shown only when verified.</span></p>
    {error && <div className="error-notice" role="alert">{error}</div>}
    {pending && !busy && <div className="plan-blockers"><p>The last change is unconfirmed. Its original request is kept in this window. Retry it before making another change.</p><button className="secondary-button" onClick={()=>void execute(pending)}>Retry the same goal request</button></div>}
    <p className="bank-feedback" role="status">{busy ? "Checking your goal request…" : notice}</p>
    <div className="plan-actions goal-toolbar"><button className="primary-button" disabled={locked||loading} onClick={()=>{epoch.current++;clearDetail();setEditing("create");setError("");}}>Add a goal</button><button className="secondary-button" disabled={locked} onClick={()=>void load()}>Reload goals</button><a href="/plan">Review savings reservations</a></div>
    {loading && <p role="status">Loading your goals…</p>}
    {!loading && page && <section className="panel goal-section" aria-labelledby="goals-heading"><div className="goal-list-heading"><h2 id="goals-heading">Your savings goals</h2><label className="plan-field">Show goals<select value={state} disabled={locked} onChange={event=>setState(event.target.value)}><option value="">Current goals</option><option value="active">Active</option><option value="paused">Paused</option><option value="completed">Completed history</option><option value="removed">Removed history</option></select></label></div>
      {page.rows.length===0 ? <p className="bank-empty">{state ? "No goals match this view." : "No savings goal yet. Start with a target that matters to you, then review how to fund it."}</p> : <ul className="goal-list">{page.rows.map(item=><li key={item.id}><div><h3>{item.name}</h3><p className="field-hint">{money(item.target_minor,item.currency)} target · {day(item.deadline)} · Priority {item.priority}</p><p className="bank-state">{item.state=== "active" ? "Active" : item.state==="paused" ? "Paused · reservations stay protected" : item.state==="removed" ? "Removed history" : "Completed history"}</p></div><button className="secondary-button" disabled={locked} aria-expanded={goal?.id===item.id} aria-label={`Review ${item.name}`} onClick={()=>void open(item.id)}>Review goal</button></li>)}</ul>}
      {page.next_cursor && <button className="text-button" disabled={locked} onClick={()=>void moreGoals()}>Show more goals</button>}
    </section>}
    {editing && <GoalForm key={editing==="edit" ? goal?.id : "create"} goal={editing==="edit" ? goal : null} locked={locked} cancel={()=>setEditing(null)} submit={fields=>{
      if(editing==="edit" && goal) command("revise","Goal changes saved. Existing reservations were kept.",fields);
      else void execute({path:"goals",body:{key:crypto.randomUUID(),...fields},message:"Goal created. No money was reserved or transferred."});
    }}/>}
    {detailLoading && <p role="status">Loading the goal and its reservations…</p>}
    {goal && <section className="panel goal-section goal-detail" aria-labelledby="goal-detail-heading">
      <div className="review-account-heading"><h2 id="goal-detail-heading" ref={goalHeading} tabIndex={-1}>{goal.name}</h2><span className="bank-state">{goal.state}</span></div>
      <dl className="plan-breakdown"><div><dt>Target</dt><dd>{money(goal.target_minor,goal.currency)}</dd></div><div><dt>Recorded active reservations</dt><dd>{goal.progress.recorded_reserved_minor===null ? "Needs reconciliation" : money(goal.progress.recorded_reserved_minor,goal.currency)}</dd></div><div><dt>Target still unreserved</dt><dd>{goal.progress.reservation_gap_minor===null ? "Not available" : money(goal.progress.reservation_gap_minor,goal.currency)}</dd></div><div><dt>Actually saved</dt><dd>Not yet verified</dd></div><div><dt>Deadline</dt><dd>{day(goal.deadline)} · {goal.progress.deadline_state}</dd></div></dl>
      <p className="field-hint">Reservations are money you earmarked in a plan. They do not confirm a saved deposit or a bank transfer.</p>
      {goal.progress.status==="unavailable" && <p className="plan-blockers">The reservation records need reconciliation. We cannot show a reliable reserved amount or gap yet.</p>}
      {goal.progress.excess_reservation_minor!==null && goal.progress.excess_reservation_minor>0 && <p className="field-hint">{money(goal.progress.excess_reservation_minor,goal.currency)} is reserved above this target. Nothing is automatically released.</p>}
      <details className="plan-evidence"><summary>Deadline pacing and calculation details</summary>
        <p>{goal.progress.required_daily_reservation_minor===null ? "No daily pace is shown for a past/today deadline or an unreconciled gap." : `${money(goal.progress.required_daily_reservation_minor,goal.currency)} per remaining Helsinki calendar day would cover the unreserved target.`}</p>
        <p>Affordability has not been assessed. This pace does not check income, competing goals or whether the deadline can be met.</p>
        <p>Read {planDate(goal.as_of)} (Helsinki). Goal version {goal.version}; collection {goal.collection_version}; data {goal.data_version}; plan {goal.plan_version}.</p>
        {goal.progress.limitations.map(item=><p key={item}>{item}</p>)}
      </details>
      {goal.state!=="removed" && <div className="plan-actions">
        {goal.currency==="EUR" && <button className="secondary-button" disabled={locked} onClick={()=>setEditing("edit")}>Edit goal</button>}
        {["active","paused"].includes(goal.state) && <button className="secondary-button" disabled={locked} onClick={()=>command("state",goal.state==="active" ? "Goal paused. Its reservations were kept." : "Goal activated.",{state:goal.state==="active" ? "paused" : "active"})}>{goal.state==="active" ? "Pause goal" : "Activate goal"}</button>}
        <button className="text-button" disabled={locked} onClick={()=>setRemoving(true)}>Remove goal</button>
      </div>}
      {goal.currency!=="EUR" && <p className="field-hint">Target editing is currently available for EUR goals. Other currencies are shown in their recorded minor units.</p>}
      {removing && <div className="bank-disconnect"><h3>Remove this goal?</h3><p>The goal will move to removed history. Active linked reservations must first be unlinked with Keep money reserved, or released from your reviewed plan.</p><div className="plan-actions"><button className="secondary-button" disabled={locked || !assignments || Boolean(assignments.next_cursor) || assignments.rows.some(item=>item.state==="active")} onClick={()=>command("remove","Goal moved to removed history.")}>Confirm remove goal</button><button className="text-button" disabled={locked} onClick={()=>setRemoving(false)}>Keep goal</button></div></div>}
      <div className="goal-reservations"><h3>Linked reservations</h3><p className="field-hint">Released entries stay visible as history and contribute nothing to active reservations.</p>
        {!assignments?.rows.length ? <p className="bank-empty">No reservation is currently linked to this goal.</p> : <ul className="reservation-list">{assignments.rows.map(item=><li key={item.id}><div><strong>{money(item.amount_minor,item.currency)}</strong><p>{item.state==="active" ? "Reserved" : "Released"} · accepted {planDate(item.accepted_at)} (Helsinki)</p><p className="field-hint">Historical acceptance receipt. No bank transfer was executed.</p></div>{item.state==="active" && goal.state!=="removed" && <button className="secondary-button" disabled={locked} onClick={()=>command(`allocations/${item.id}/unlink`,"Reservation unlinked. The money remains reserved in your plan.",{reservation_choice:"keep_reserved"})}>Keep money reserved; unlink</button>}</li>)}</ul>}
        {assignments?.next_cursor && <button className="text-button" disabled={locked} onClick={()=>void moreAssignments()}>Show more linked reservations</button>}
      </div>
      {goal.state==="active" && <div className="goal-link"><h3>Use an existing reservation</h3><p className="field-hint">Choose an active reservation from your current reviewed plan. Linking it does not reserve the money again. A reservation already linked elsewhere must be unlinked there first.</p>
        <button className="secondary-button" disabled={locked} onClick={()=>void reservations()}>Load current plan reservations</button>
        {candidatePage && <>{choices.length ? <><label className="plan-field">Reservation to link<select value={selectedAllocation} disabled={locked} onChange={event=>setSelectedAllocation(event.target.value)}><option value="">Choose a reservation</option>{choices.map(item=><option key={item.id} value={item.id}>{money(item.amount_minor,item.currency)} · {planDate(item.accepted_at)} · {item.id.slice(-8)}</option>)}</select></label><button className="primary-button" disabled={locked||!selectedAllocation} onClick={()=>command(`allocations/${selectedAllocation}/link`,"Existing reservation linked. No additional money was reserved.")}>Link existing reservation</button></> : <p className="field-hint">No unlisted active reservation in the same currency appears on these loaded pages. Review your plan or load more history.</p>}
          {candidatePage.next_cursor && <button className="text-button" disabled={locked} onClick={()=>void reservations(true)}>Load more plan reservations</button>}</>}
      </div>}
    </section>}
  </>;
}
