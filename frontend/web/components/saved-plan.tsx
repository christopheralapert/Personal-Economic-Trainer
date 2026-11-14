"use client";

import {useEffect, useRef, useState} from "react";
import type {components} from "@contracts";
import {aborted, type PrivateRequest} from "./private-session";
import {blockerText, euros, parseEuro, planDate, protectionLabels} from "./plan-format";

type Schema = components["schemas"];
export type PlanBundle = {plan: Schema["PlanViewV1"]; review: Schema["SavedPlanReviewV1"] | null; history: Schema["AllocationPageV1"]};

export function SavedPlan({bundle, context, request, refresh, changed, edit}: {
  bundle: PlanBundle; context: Schema["ReviewContextV1"] | null; request: PrivateRequest;
  refresh: () => Promise<void>; changed: () => void; edit: () => void;
}) {
  const {plan, review} = bundle;
  const [history, setHistory] = useState(bundle.history);
  const [desired, setDesired] = useState("");
  const [saving, setSaving] = useState("");
  const [account, setAccount] = useState("");
  const [proposal, setProposal] = useState<Schema["AllocationProposalV1"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState("");
  const [errorTarget, setErrorTarget] = useState<"allocation" | "history">("allocation");
  const [expired, setExpired] = useState(false);
  const acceptCommand = useRef<Schema["AcceptAllocationV1"] | null>(null);
  const releaseCommands = useRef(new Map<string, Schema["ReleaseAllocationV1"]>());
  const usable = plan.current && review !== null && !expired && !uncertain;
  const canAllocate = usable && context !== null;
  const outcome = usable ? plan.calculation : null;
  const liquid = review?.inputs.accounts.filter(item => item.liquid && ["current", "savings"].includes(item.account_type)) ?? [];
  const costs = review?.inputs.costs ?? [];
  const confirmedIncome = (review?.inputs.incomes ?? []).some(item => item.confirmed);
  const accountName = (id: string) => context?.accounts.find(item => item.id === id)?.name ?? `Account reference ${id.slice(-8)}`;

  useEffect(() => {
    const check = () => setExpired(Date.now() >= Date.parse(plan.expires_at));
    check(); const interval = window.setInterval(check, 1000);
    return () => window.clearInterval(interval);
  }, [plan.expires_at]);

  async function preview(event: React.FormEvent) {
    event.preventDefault(); setError(""); setErrorTarget("allocation"); setProposal(null);
    let body: Schema["ProposalRequestV1"];
    try { body = {desired_discretionary_minor: parseEuro(desired), chosen_savings_minor: parseEuro(saving)}; }
    catch (reason) { setError((reason as Error).message); return; }
    setBusy(true);
    try { setProposal(await request<Schema["AllocationProposalV1"]>(`plans/${plan.id}/proposal`, body)); }
    catch (reason) { if (!aborted(reason)) setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  async function accept() {
    setError(""); setErrorTarget("allocation");
    if (!acceptCommand.current) {
      if (!proposal || proposal.status !== "estimated" || proposal.chosen_savings_minor == null ||
        proposal.chosen_savings_minor <= 0 || !liquid.some(item => item.id === account)) {
        setError("Preview a positive saving amount and choose its funding account first."); return;
      }
      acceptCommand.current = {key: crypto.randomUUID(), expected_data_version: plan.data_version,
        expected_plan_version: plan.plan_version, account_id: account, amount_minor: proposal.chosen_savings_minor,
        desired_discretionary_minor: proposal.desired_discretionary_minor!};
    }
    setBusy(true);
    try {
      await request<Schema["AllocationReceiptV1"]>(`plans/${plan.id}/allocations`, acceptCommand.current);
      changed(); await refresh();
    } catch (reason) {
      if (!aborted(reason)) { setUncertain(true); setError(`${(reason as Error).message} Refresh reservations before making a different choice, or retry the same request.`); }
    } finally { setBusy(false); }
  }

  async function release(id: string) {
    setBusy(true); setError(""); setErrorTarget("history");
    const body = releaseCommands.current.get(id) ?? {key: crypto.randomUUID(), expected_data_version: history.data_version,
      expected_plan_version: history.plan_version};
    releaseCommands.current.set(id, body);
    try {
      await request<Schema["AllocationReceiptV1"]>(`plans/${plan.id}/allocations/${id}/release`, body);
      changed(); await refresh();
    } catch (reason) { if (!aborted(reason)) {setUncertain(true); setError(`${(reason as Error).message} Refresh reservations or retry this release.`);} }
    finally { setBusy(false); }
  }

  async function page(cursor?: string) {
    setBusy(true); setError(""); setErrorTarget("history");
    try { setHistory(await request<Schema["AllocationPageV1"]>(`plans/${plan.id}/allocations${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`)); }
    catch (reason) { if (!aborted(reason)) setError((reason as Error).message); }
    finally { setBusy(false); }
  }

  return <div className="private-plan-grid">
    <section className="panel saved-plan-section" aria-labelledby="saved-plan-heading">
      <div className="section-heading"><h2 id="saved-plan-heading">Your reviewed spending room</h2><span className="estimate-label">{usable ? "Estimate" : "Review needed"}</span></div>
      <p className="muted">Reviewed {planDate(plan.as_of)}{outcome && <> · protecting costs through {planDate(outcome.prepared.period.protection_through)}</>}</p>
      {outcome && <p className="field-hint">Requested spending window: {planDate(outcome.prepared.period.requested_from)} up to {planDate(outcome.prepared.period.requested_to_exclusive)}.</p>}
      <div className="spending-amount" data-testid="private-spending-room">{outcome?.amount_minor != null ? euros(outcome.amount_minor) : <span className="muted">Review needed</span>}</div>
      {outcome && <p>This is the shared flexible money left after the reviewed costs and protections, before a new savings choice.</p>}
      {!usable && <p className="plan-blockers" role="status">{uncertain ? "That request may have been saved. Refresh reservations or retry the same request before using a spending figure." : "This estimate expired or its source facts changed. Historical reservations remain below. Fresh source information and a new review are needed before using a spending amount."}</p>}
      {outcome?.baseline && <>
        {outcome.baseline.consolidated.shortfall_minor > 0 && <p className="plan-blockers">A shortfall of <strong>{euros(outcome.baseline.consolidated.shortfall_minor)}</strong> occurs at {planDate(outcome.baseline.consolidated.minimum_headroom_at)}. Zero allowance does not mean these costs are covered.</p>}
        <dl className="plan-breakdown">{review?.inputs.protections.map(item => <div key={item.id}><dt>{protectionLabels[item.kind]}</dt><dd>{item.amount_minor == null ? "Needs review" : euros(item.amount_minor)}</dd></div>)}</dl>
        <p className="field-hint">The estimate uses the lowest dated account headroom. Protected budgets and their linked payments are not separate copies of the same cost.</p>
        <details className="plan-evidence"><summary>Accounts, costs and assumptions</summary>
          <h3>Account funding</h3><ul>{outcome.baseline.accounts.map(item => <li key={item.account_id}>{accountName(item.account_id)}: minimum headroom {euros(item.forecast.minimum_headroom_minor)} at {planDate(item.forecast.minimum_headroom_at)}</li>)}</ul>
          <h3>Reviewed costs</h3>{costs.length ? <ul>{costs.slice(0, 20).map(item => <li key={item.id}>{euros(item.amount_minor)} · {planDate(item.at)} · {accountName(item.account_id)}{item.opening_reflected ? " · already reflected in balance" : ""}</li>)}</ul> : <p>No separate dated costs were included in this review.</p>}
          {costs.length > 20 && <p>Showing the first 20 of {costs.length} reviewed costs. The calculation includes every reviewed cost.</p>}
          <h3>Planning assumptions</h3><ul>{plan.analysis.assumptions.map((item,index) => <li key={index}>{item}</li>)}</ul>
          <p>Data version {plan.data_version} · plan version {plan.plan_version}. Balances and source observations stay server-owned.</p>
        </details>
      </>}
      <div className="plan-actions"><button className="secondary-button" disabled={busy} onClick={() => void refresh()}>Refresh saved plan</button><button className="text-button" disabled={busy || !context} onClick={edit}>Review a replacement plan</button></div>
    </section>

    {review && <section className="panel allocation-panel" aria-labelledby="allocation-heading">
      <h2 id="allocation-heading">Choose what to keep flexible</h2>
      <p className="muted">Spending and saving share one surplus. A preview leaves your money unchanged.</p>
      <form onSubmit={preview}><fieldset disabled={busy || !canAllocate || uncertain}>
        <legend className="sr-only">Savings proposal</legend>
        <label className="plan-field">Keep for discretionary spending (EUR)<input inputMode="decimal" autoComplete="off" maxLength={20} value={desired} onChange={event => {setDesired(event.target.value); setProposal(null);}} placeholder="Choose an amount"/></label>
        <label className="plan-field">Proposed new savings (EUR)<input inputMode="decimal" autoComplete="off" maxLength={20} value={saving} onChange={event => {setSaving(event.target.value); setProposal(null);}} placeholder="Choose an amount"/></label>
        <label className="plan-field">Account funding the reservation<select value={account} onChange={event => setAccount(event.target.value)}><option value="">Choose an account</option>{liquid.map(item => <option key={item.id} value={item.id}>{accountName(item.id)}</option>)}</select></label>
        <button className="secondary-button" type="submit">{busy ? "Calculating…" : "Preview allocation"}</button>
      </fieldset></form>
      {proposal && <div className="allocation-preview" role="status">{proposal.status === "estimated" ? <>
        <p>Reserve <strong>{euros(proposal.chosen_savings_minor ?? 0)}</strong> and leave <strong>{euros(proposal.remaining_spending_minor ?? 0)}</strong> for spending, including your discretionary preference.</p>
        <p className="field-hint">Maximum new savings for this preference: {euros(proposal.savings_capacity_minor ?? 0)}.</p>
      </> : <ul>{proposal.blockers.map((item,index) => <li key={index}>{blockerText[item.code] ?? "Review your spending preference and savings amount."}</li>)}</ul>}</div>}
      {error && errorTarget === "allocation" && <p className="plan-blockers" role="alert">{error}</p>}
      <button className="primary-button" disabled={busy || (uncertain ? !acceptCommand.current : !canAllocate || !proposal || proposal.status !== "estimated" || !proposal.chosen_savings_minor || !account)} onClick={() => void accept()}>
        {busy ? "Saving choice…" : uncertain && acceptCommand.current ? "Retry the same savings request" : "Confirm savings reservation"}</button>
      <p className="fine-print">Confirmation earmarks funds in this plan. It does not transfer money between bank accounts.</p>
    </section>}

    {outcome && (confirmedIncome || outcome.lower_cost_scenario) && <section className="plan-stress panel"><h2>How the assumptions change the estimate</h2><p className="muted">Scenarios over the same protection period.</p>
      <dl className="plan-breakdown">{confirmedIncome && <><div><dt>Confirmed income absent</dt><dd>{outcome.absent_income?.amount_minor != null ? euros(outcome.absent_income.amount_minor) : "Review needed"}</dd></div>
        <div><dt>Confirmed income delayed {outcome.stress_delay_days} days</dt><dd>{outcome.delayed_income?.amount_minor != null ? euros(outcome.delayed_income.amount_minor) : "Review needed"}</dd></div></>}
        {outcome.lower_cost_scenario && <div><dt>If reviewed costs are lower</dt><dd>{outcome.lower_cost_scenario.amount_minor != null ? euros(outcome.lower_cost_scenario.amount_minor) : "Review needed"}</dd></div>}</dl>
      <p className="field-hint">These are scenarios, not confidence intervals. Reservations always use the protective baseline.</p></section>}

    <section className="panel reservation-section" aria-labelledby="reservations-heading">
      <h2 id="reservations-heading">Your savings reservations</h2><p className="muted">Durable receipts from this plan. Acceptance amounts describe the historical choice.</p>
      {error && errorTarget === "history" && <p className="plan-blockers" role="alert">{error}</p>}
      {history.rows.length ? <ul className="reservation-list">{history.rows.map(item => <li key={item.id}>
        <div><strong>{euros(item.amount_minor)} · {item.state === "active" ? "Reserved" : "Released"}</strong><p>{accountName(item.account_id)} · accepted {planDate(item.accepted_at)}</p><p className="field-hint">No bank transfer was executed.</p></div>
        {item.state === "active" && <button className="secondary-button" disabled={busy} onClick={() => void release(item.id)}>Release {euros(item.amount_minor)} reservation</button>}
      </li>)}</ul> : <p className="empty-state">No new savings have been reserved in this plan.</p>}
      <div className="plan-actions">{history.next_cursor && <button className="secondary-button" disabled={busy} onClick={() => void page(history.next_cursor!)}>Next reservation receipts</button>}
        <button className="text-button" disabled={busy} onClick={() => void page()}>Reload newest receipts</button></div>
    </section>
  </div>;
}
