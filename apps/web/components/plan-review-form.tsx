"use client";

import {useRef, useState} from "react";
import type {components} from "@contracts";
import {aborted, type PrivateRequest} from "./private-session";
import {blockerText, euros, parseEuro, planDate, protectionLabels, sumMinor} from "./plan-format";

type Context = components["schemas"]["ReviewContextV1"];
type Create = components["schemas"]["CreateReviewedPlanV1"];
type Result = components["schemas"]["ReviewedPlanResultV1"];
type Blocker = components["schemas"]["PlanningBlockerV1"];
type ExtraCost = {id: string; amount: string; account: string; date: string};
const kinds = Object.keys(protectionLabels) as (keyof typeof protectionLabels)[];

export function PlanningBlockers({items, context}: {items: Blocker[]; context: Context}) {
  const unique = [...new Map(items.map(item => [item.code + (item.account_id ?? "") + (item.item_id ?? ""), item])).values()];
  return <div className="plan-blockers" role="alert"><h3>Review needed before an amount is available</h3><ul>{unique.map((item, index) =>
    <li key={index}>{item.account_id && <strong>{context.accounts.find(account => account.id === item.account_id)?.name ?? "Account"}: </strong>}
      {blockerText[item.code] ?? "Review the amounts, dates and account funding for this input before continuing."}</li>)}</ul></div>;
}

export function PlanReviewForm({context, request, saved, refresh}: {context: Context; request: PrivateRequest; saved: () => Promise<void>; refresh: () => void}) {
  const liquid = context.accounts.filter(account => ["current", "savings"].includes(account.account_type));
  const unsupportedCurrency = context.accounts.some(account => account.currency !== "EUR" || (account.balance && account.balance.currency !== "EUR")) ||
    context.obligations.some(item => item.currency !== "EUR") || context.pending.some(item => item.currency !== "EUR");
  const [coverage, setCoverage] = useState<Record<string, boolean>>({});
  const [inaccessible, setInaccessible] = useState<Record<string, string>>({});
  const [liabilities, setLiabilities] = useState<Record<string, boolean>>({});
  const [routes, setRoutes] = useState<Record<string, string>>({});
  const [costs, setCosts] = useState<ExtraCost[]>([]);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [blockers, setBlockers] = useState<Blocker[]>([]);
  const [uncertain, setUncertain] = useState(false);
  const draft = useRef<Create | null>(null);
  // Review an explicitly displayed extra day, allowing time to complete the form
  // without silently extending the user's actual reviewed horizon at submission.
  const through = new Date(Date.parse(context.period.protection_through) + 86400000).toISOString();

  function build(): Create {
    if (!confirmed) throw new Error("Confirm the reviewed period after checking your amounts and upcoming bills.");
    const protections = kinds.map(kind => {
      const routed = liquid.map(account => ({account_id: account.id, amount_minor: parseEuro(routes[`${kind}:${account.id}`] ?? "")}));
      return {id: crypto.randomUUID(), kind, amount_minor: sumMinor(routed.map(route => route.amount_minor)),
        reviewed_through: through, routes: routed.filter(route => route.amount_minor > 0)};
    });
    return {key: crypto.randomUUID(), expected_data_version: context.data_version, expected_plan_version: context.plan_version,
      accounts: context.accounts.map(account => ({account_id: account.id, balance_snapshot_id: account.balance?.id ?? null,
        inaccessible_minor: liquid.some(item => item.id === account.id) ? parseEuro(inaccessible[account.id] ?? "") : null,
        coverage_confirmed: coverage[account.id] === true, liability_covered: account.account_type === "credit" ? liabilities[account.id] === true : null})),
      protections, obligations_reviewed_through: through,
      extra_costs: costs.map(cost => {
        if (!liquid.some(account => account.id === cost.account) || !/^\d{4}-\d{2}-\d{2}$/.test(cost.date))
          throw new Error("Choose a paying account and due date for every extra cost.");
        const at = `${cost.date}T00:00:00Z`;
        if (!Number.isFinite(Date.parse(at))) throw new Error("Choose a valid due date.");
        return {id: cost.id, economic_cost_id: cost.id, account_id: cost.account, amount_minor: parseEuro(cost.amount),
          at, opening_reflected: false, kind: "bill" as const, amount_basis: "reviewed" as const};
      })};
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBlockers([]);
    let command: Create;
    try { command = draft.current ?? build(); } catch (reason) { setError((reason as Error).message); return; }
    draft.current = command; setBusy(true);
    try {
      const result = await request<Result>("plans", command);
      if (!result.plan) { setBlockers(result.calculation?.blockers ?? []); draft.current = null; setUncertain(false); }
      else await saved();
    } catch (reason) {
      if (!aborted(reason)) {
        setError(`${(reason as Error).message} Check the saved plan before starting a different review, or retry this same review.`);
        setUncertain(true);
      }
    } finally { setBusy(false); }
  }

  return <section className="panel review-panel" aria-labelledby="review-heading">
    <h2 id="review-heading">Review your next 30 days</h2>
    <p className="muted">Protect costs through <strong>{planDate(through)}</strong>. The bank balance and your spending room are different: costs need a paying account.</p>
    {unsupportedCurrency && <p className="plan-blockers" role="alert">This source includes another currency. Reviewed currency coverage is needed before creating a EUR plan; no conversion is available.</p>}
    <form onSubmit={submit}>
      <fieldset disabled={busy || uncertain || context.existing_reservations_require_review || unsupportedCurrency}>
        <legend>Accounts and available money</legend>
        <p className="field-hint">Check every included account. Enter 0 explicitly if none of its own money is inaccessible.</p>
        {context.accounts.map(account => <div className="review-account" key={account.id}>
          <div className="review-account-heading"><h3>{account.name}</h3><strong>{account.balance ? account.currency === "EUR" && account.balance.currency === "EUR" ? euros(account.balance.amount_minor) : "Outside EUR plan" : "Balance missing"}</strong></div>
          <p className="field-hint">{account.currency} {account.account_type} account{account.balance && <> · {account.balance.kind} balance observed {planDate(account.balance.observed_at)}</>}</p>
          {["current", "savings"].includes(account.account_type) && <label className="plan-field">Money unavailable to spend (EUR)
            <input inputMode="decimal" autoComplete="off" maxLength={20} value={inaccessible[account.id] ?? ""} placeholder="Enter an amount, including 0"
              onChange={event => setInaccessible({...inaccessible, [account.id]: event.target.value})}/></label>}
          <label className="check-field"><input type="checkbox" checked={coverage[account.id] ?? false} onChange={event => setCoverage({...coverage, [account.id]: event.target.checked})}/>
            <span>I reviewed this account&apos;s current information.</span></label>
          {account.account_type === "credit" && <label className="check-field"><input type="checkbox" checked={liabilities[account.id] ?? false} onChange={event => setLiabilities({...liabilities, [account.id]: event.target.checked})}/>
            <span>I included its settlement costs in the obligations reviewed below.</span></label>}
        </div>)}
      </fieldset>
      <fieldset disabled={busy || uncertain || context.existing_reservations_require_review || unsupportedCurrency}>
        <legend>Keep these amounts protected</legend>
        <p className="field-hint">Enter each amount once, in the account holding it. Use 0 for a reviewed zero. These reserves cover the whole period above.</p>
        {kinds.map(kind => <div className="protection-group" key={kind}><h3>{protectionLabels[kind]}</h3>
          <div className="plan-fields">{liquid.map(account => <label className="plan-field" key={account.id}>{account.name} (EUR)
            <input inputMode="decimal" autoComplete="off" maxLength={20} value={routes[`${kind}:${account.id}`] ?? ""} placeholder="Amount, including 0"
              onChange={event => setRoutes({...routes, [`${kind}:${account.id}`]: event.target.value})}/></label>)}</div>
        </div>)}
      </fieldset>
      <fieldset disabled={busy || uncertain || context.existing_reservations_require_review || unsupportedCurrency}>
        <legend>Upcoming costs outside those reserves</legend>
        <p className="field-hint">Known source bills and pending debits are included automatically. Add other costs only when they are outside the protected amounts above. Due dates use the start of the selected UTC day, conservatively before later receipts.</p>
        {context.obligations.length > 0 && <details><summary>{context.obligations.length} planned source bills</summary><ul>{context.obligations.map(item =>
          <li key={item.id}>{item.currency === "EUR" ? euros(item.amount_minor) : `${item.currency} cost outside EUR plan`} · {planDate(item.due_at)} · {context.accounts.find(account => account.id === item.account_id)?.name ?? "Unavailable account"}</li>)}</ul></details>}
        {context.pending.length > 0 && <p className="field-hint">{context.pending.length} pending source records were found. Pending receipts cannot fund this plan. Unmatched pending debits and bills stay protected separately.</p>}
        {costs.map((cost, index) => <div className="extra-cost" key={cost.id}>
          <h3>Additional cost {index + 1}</h3><div className="plan-fields">
            <label className="plan-field">Cost amount (EUR)<input inputMode="decimal" autoComplete="off" maxLength={20} value={cost.amount} onChange={event => setCosts(costs.map(item => item.id === cost.id ? {...item, amount: event.target.value} : item))}/></label>
            <label className="plan-field">Due date<input type="date" value={cost.date} onChange={event => setCosts(costs.map(item => item.id === cost.id ? {...item, date: event.target.value} : item))}/></label>
            <label className="plan-field">Paying account<select value={cost.account} onChange={event => setCosts(costs.map(item => item.id === cost.id ? {...item, account: event.target.value} : item))}>
              <option value="">Choose an account</option>{liquid.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          </div><button className="text-button" type="button" onClick={() => setCosts(costs.filter(item => item.id !== cost.id))}>Remove additional cost {index + 1}</button>
        </div>)}
        <button className="secondary-button" type="button" disabled={costs.length >= 20} onClick={() => setCosts([...costs, {id: crypto.randomUUID(), amount: "", account: "", date: ""}])}>Add an upcoming cost</button>
        <label className="check-field period-confirmation"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>
          <span>I reviewed all four protections and known bills through <strong>{planDate(through)}</strong>, including essential costs not visible in the transaction history.</span></label>
      </fieldset>
      {context.existing_reservations_require_review && <p className="plan-blockers" role="status">Existing unspent reservations need review before this plan can be replaced. Open your saved plan and review its reservations first.</p>}
      {error && <p className="plan-blockers" role="alert">{error}</p>}
      {blockers.length > 0 && <PlanningBlockers items={blockers} context={context}/>}
      <div className="plan-actions"><button className="primary-button" disabled={busy || context.existing_reservations_require_review || unsupportedCurrency} type="submit">{busy ? "Reviewing…" : uncertain ? "Retry the same review" : "Calculate and save reviewed plan"}</button>
        <button className="secondary-button" disabled={busy} type="button" onClick={refresh}>{uncertain ? "Check saved plan" : "Reload source details"}</button></div>
      <p className="fine-print">This saves reviewed assumptions. It does not reserve new savings or move money. Blank amounts stay unknown; the source observation time is never changed by this form.</p>
    </form>
  </section>;
}
