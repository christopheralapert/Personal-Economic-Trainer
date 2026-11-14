"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { components } from "@contracts";
import {LegalLinks} from "./legal-links";

type Profile = components["schemas"]["Profile"];
type Plan = components["schemas"]["PlanResponse"];
type Scenario = components["schemas"]["ScenarioResponse"];
type View = "overview" | "transactions" | "scenario" | "sources";
const money = (value: number) => new Intl.NumberFormat("fi-FI", {style: "currency", currency: "EUR", maximumFractionDigits: value % 100 === 0 ? 0 : 2}).format(value / 100);
const labels: Record<string, string> = {taxi: "Taxis", dining: "Dining out", housing: "Housing", groceries: "Groceries", repairs: "Essential repairs", coffee: "Coffee"};
const basketLabels: Record<string, string> = {mandatory_regular: "Mandatory & regular", mandatory_irregular: "Mandatory & irregular", everyday: "Everyday spending", unresolved: "Needs review"};

function Icon({name, className = ""}: {name: string; className?: string}) {
  const paths: Record<string, React.ReactNode> = {
    overview: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><path d="M3 14h7v7H3zM14 14h7v7h-7z"/></>,
    transactions: <><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></>,
    scenario: <><path d="M4 7h7M15 7h5M4 17h3M11 17h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></>,
    sources: <><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h8M8 17h5"/></>,
    arrow: <path d="M5 12h14M13 6l6 6-6 6"/>,
    bank: <><path d="m3 8 9-5 9 5M3 21h18M5 10v8M10 10v8M15 10v8M20 10v8"/></>,
    taxi: <><path d="m4 10 2-5h12l2 5v8H4zM4 11h16M6 18v2M18 18v2M8 14h.01M16 14h.01"/></>,
    dining: <><path d="M5 3v7M8 3v7M2 3v7c0 2 6 2 6 0M5 12v9M16 3c-4 4-4 10 0 10h3M19 3v18"/></>,
    housing: <><path d="m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8"/></>,
    groceries: <><path d="M3 5h3l3 11h10l2-8H7"/><circle cx="10" cy="20" r="1"/><circle cx="18" cy="20" r="1"/></>,
    coffee: <><path d="M4 8h12v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4zM16 9h2a3 3 0 0 1 0 6h-2M7 3v2M12 3v2"/></>,
    repairs: <><path d="m14 6 4-3c4 4 1 9-3 8L6 21l-3-3 10-9c-1-4 1-6 3-6"/></>,
  };
  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.sources}</svg>;
}

async function api<T>(path: string, body?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/demo/${path}`, {cache: "no-store", signal,
    method: body ? "POST" : "GET", headers: body ? {"Content-Type": "application/json"} : undefined,
    body: body ? JSON.stringify(body) : undefined});
  if (!response.ok) throw new Error("Demo data is temporarily unavailable. Please try again.");
  return response.json();
}

export function Workspace() {
  const [view, setView] = useState<View>("overview");
  const [profile, setProfile] = useState<Profile | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [scenario, setScenario] = useState<Scenario | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [online, setOnline] = useState(true);
  const [savings, setSavings] = useState(5000);
  const [percent, setPercent] = useState(20);
  const [filter, setFilter] = useState("");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [calculating, setCalculating] = useState(false);
  const [scenarioBusy, setScenarioBusy] = useState(false);
  const latest = useRef({savings, percent});
  latest.current = {savings, percent};

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setError("");
    try {
      const [data, quote, projection] = await Promise.all([
        api<Profile>("profile", undefined, signal), api<Plan>("plan", {savings_minor: latest.current.savings}, signal),
        api<Scenario>("scenario", {percent: latest.current.percent, months: 12}, signal),
      ]);
      setProfile(data); setPlan(quote); setScenario(projection);
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === "AbortError")) setError("Demo data is temporarily unavailable. Please try again.");
    } finally { if (!signal?.aborted) {setLoading(false); setCalculating(false); setScenarioBusy(false);} }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    // Initial bootstrap only. Later changes recalculate their own deterministic preview.
    void load(controller.signal);
    const offline = () => { setOnline(false); setAnswer(""); };
    const reconnect = () => { setOnline(true); void load(); };
    setOnline(navigator.onLine);
    window.addEventListener("offline", offline); window.addEventListener("online", reconnect);
    return () => {controller.abort(); window.removeEventListener("offline", offline); window.removeEventListener("online", reconnect);};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!profile || !online || loading) return;
    const controller = new AbortController();
    setCalculating(true);
    const timer = window.setTimeout(() => {
      void api<Plan>("plan", {savings_minor: savings}, controller.signal).then(setPlan)
        .catch(reason => {if (reason.name !== "AbortError") setError("The updated plan could not be calculated. Please retry.");})
        .finally(() => {if (!controller.signal.aborted) setCalculating(false);});
    }, 150);
    return () => {window.clearTimeout(timer); controller.abort();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savings, online]);

  useEffect(() => {
    if (!profile || !online || loading) return;
    setScenarioBusy(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void api<Scenario>("scenario", {percent, months: 12}, controller.signal).then(setScenario)
        .catch(reason => {if (reason.name !== "AbortError") setError("The scenario could not be calculated. Please retry.");})
        .finally(() => {if (!controller.signal.aborted) setScenarioBusy(false);});
    }, 150);
    return () => {window.clearTimeout(timer); controller.abort();};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [percent, online]);

  const october = useMemo(() => profile?.transactions.filter(tx => tx.status === "booked" && tx.booked_on >= "2026-10-01" && tx.booked_on < "2026-11-01") ?? [], [profile]);
  const spending = useMemo(() => Object.entries(profile?.october_spending ?? {}).sort((a,b) => b[1] - a[1]), [profile]);
  const transactions = october.filter(tx => `${tx.merchant} ${labels[tx.category] ?? tx.category}`.toLowerCase().includes(filter.toLowerCase()));
  const balance = profile?.available_balance_minor ?? 0;

  function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!profile || !plan || !scenario || !online || calculating || scenarioBusy || loading) return;
    const text = question.toLowerCase();
    if (/taxi/.test(text)) {
      setAnswer(`${money(profile.october_spending.taxi)} across ${profile.october_taxi_count} taxi payments in October 2026. Both demo accounts are included. Select Transactions and search “taxi” to inspect the source records.`);
    } else if (/20|dining|restaurant/.test(text)) {
      setAnswer(`${money(scenario.monthly_reduction_minor)} per month in this ${percent}% dining scenario, or ${money(scenario.total_reduction_minor)} over 12 months if repeated. This is a scenario, not a prediction. You can change it in What if.`);
    } else if (/safe|spend|week/.test(text)) {
      setAnswer(`${money(plan.remaining_spending_minor ?? 0)} remains for spending after proposing ${money(plan.proposed_savings_minor)} for savings. The shared surplus is ${money(plan.analysis.result.surplus_minor ?? 0)}. This synthetic plan protects obligations through 4 December 2026; the savings proposal is not persisted.`);
    } else if (/kind|habit|pattern/.test(text)) {
      setAnswer(`Housing and dining are the largest expense categories in this small October fixture. The three spending baskets describe flexibility; a merchant alone cannot establish necessity. Full personalized behavior analysis is still planned.`);
    } else {
      setAnswer("This first demo supports October taxi totals, the current spending/saving preview, the dining scenario, and a simple spending-pattern explanation. General AI conversations and other periods are still being built.");
    }
  }

  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Money Coach home"><img src="/icons/icon.svg" width="32" height="32" alt=""/>Money Coach</a>
      <p className="sidebar-subtitle">Your money, explained.</p>
      <nav aria-label="Main navigation">{([ ["overview", "Overview"], ["transactions", "Transactions"], ["scenario", "What if"], ["sources", "Data & progress"] ] as [View, string][]).map(([key, label]) =>
        <button className={view === key ? "nav-item active" : "nav-item"} key={key} onClick={() => setView(key)} aria-current={view === key ? "page" : undefined}><Icon name={key}/><span>{label}</span></button>)}</nav>
      <div className="sidebar-footer"><a href="/analysis">Explore your spending</a><p><a href="/plan">Open your reviewed plan</a></p><p><span className="demo-dot"/>Synthetic development demo</p><p>Challenge 311 · S-Bank</p></div>
    </aside>
    <div className="workspace">
      <header className="topbar"><span>Personal economic trainer</span><div className="profile-label"><span className="avatar">D</span><span>Demo household</span></div></header>
      <main id="main" className="main-content" aria-busy={loading}>
        <div className="page-heading"><div><h1>{view === "overview" ? "Make room for what matters." : view === "transactions" ? "Follow the money." : view === "scenario" ? "Small changes. Clear possibilities." : "Know what’s behind the numbers."}</h1><p>{view === "overview" ? "A little clarity for your everyday decisions." : view === "transactions" ? "Explore the transactions behind this synthetic example." : view === "scenario" ? "Try a different plan before changing a habit." : "Transparent sources and an honest view of what’s ready."}</p></div><span className="date-label">4 November 2026</span></div>
        <div className="demo-notice"><span className="demo-dot"/><span>Synthetic example · estimates use a fixed demo clock. No real bank accounts are connected. <a href="/analysis">Explore your spending</a> or <a href="/plan">Review your own synthetic profile</a>.</span></div>
        {!online && <div className="error-notice" role="status">You’re offline. These in-memory figures may be stale; financial actions are paused.</div>}
        {error && <div className="error-notice" role="alert"><span>{error}</span><button onClick={() => void load()} disabled={!online || loading}>Try again</button></div>}
        {loading && !profile && <div className="loading-state" role="status">Preparing your synthetic example…</div>}
        {profile && plan && scenario && <>
          {view === "overview" && <div className="overview-grid">
            <section className="plan-section panel">
              <div className="section-heading"><h2>Your spending room</h2><span className="estimate-label">Estimate</span></div>
              <p className="muted">4–8 November · protecting your next 30 days</p>
              <div className="spending-amount" aria-live="polite">{calculating ? <span className="muted">Calculating…</span> : money(plan.remaining_spending_minor ?? 0)}</div>
              <p>After proposing <strong>{money(savings)}</strong> for savings, from the same {money(plan.analysis.result.surplus_minor ?? 0)} of flexible money.</p>
              <div className="allocation-control"><label htmlFor="savings">Try a savings allocation <strong>{money(savings)}</strong></label><input id="savings" type="range" min="0" max={plan.analysis.result.surplus_minor ?? 0} step="500" value={savings} onChange={event => setSavings(Number(event.target.value))} disabled={!online || loading}/><div className="range-labels"><span>Keep it flexible</span><span>Set more aside</span></div></div>
              <div className="breakdown"><div><span>Available across two demo banks</span><strong>{money(balance)}</strong></div><div><span>Upcoming bills</span><span>−{money(plan.bills_minor)}</span></div><div><span>Essential spending</span><span>−{money(plan.essentials_minor)}</span></div><div><span>Safety buffer</span><span>−{money(plan.buffer_minor)}</span></div><div className="breakdown-total"><span>Shared flexible money</span><strong>{money(plan.analysis.result.surplus_minor ?? 0)}</strong></div></div>
              <details><summary>View calculation and assumptions</summary><p>The fixed available balance is {money(balance)}. Bills, essentials and buffer cover the protection horizon through 4 December 2026. No future income, extra irregular reserve, or existing savings commitment is included.</p><p>This is a preview. Moving the slider does not reserve or transfer money. Source: {profile.fixture_version}; calculation version {plan.analysis.calculation_version}.</p></details>
            </section>
            <section className="coach-section panel"><div className="section-heading"><h2>Start with a question</h2><Icon name="arrow"/></div><p className="muted">Explore the numbers, one question at a time.</p><div className="question-examples">{["How much did I spend on taxis last month?", "What is safe to spend this week?", "What if I reduced dining out by 20%?"].map(text => <button key={text} onClick={() => {setQuestion(text); setAnswer("");}} disabled={!online || loading}>{text}<Icon name="arrow"/></button>)}</div><form onSubmit={ask}><label className="sr-only" htmlFor="question">Ask about the demo finances</label><div className="question-input"><input id="question" value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about the demo finances…" maxLength={500} disabled={!online || loading}/><button type="submit" aria-label="Ask question" disabled={!question.trim() || !online || loading || calculating || scenarioBusy}><Icon name="arrow"/></button></div></form>{answer && <p className="coach-answer" role="status">{answer}</p>}<p className="fine-print">Deterministic demo answers. General AI conversation is still in development.</p></section>
            <section className="spending-section panel"><div className="section-heading"><h2>Where October went</h2><button className="text-button" onClick={() => setView("transactions")}>See transactions <Icon name="arrow"/></button></div><p className="muted">Booked expenses, net of refunds · both demo accounts</p><div className="category-list">{spending.map(([category, amount]) => <div className="category-row" key={category}><span className="category-icon"><Icon name={category}/></span><span className="category-name">{labels[category] ?? category}</span><strong>{money(amount)}</strong></div>)}</div></section>
            <section className="accounts-section"><h2>A fuller picture, together.</h2><p className="muted">Two synthetic account sources. Consent and live connections are upcoming work.</p>{profile.accounts.map(account => <div className="account-row" key={account.id}><span className="bank-icon"><Icon name="bank"/></span><div><strong>{account.name}</strong><small>EUR current account · synthetic fixture</small></div><strong>{money(profile.balances.find(item => item.account_id === account.id)?.amount_minor ?? 0)}</strong></div>)}<div className="learning-note"><h3>Balance is only the beginning</h3><p>Your balance shows what is there. Spending room also considers the costs you need to protect.</p></div></section>
          </div>}
          {view === "transactions" && <section className="panel"><div className="section-heading"><h2>October 2026 transactions</h2><span className="muted">{transactions.length} records</span></div><label className="search-label" htmlFor="filter">Find a merchant or category</label><input className="search-input" id="filter" value={filter} onChange={event => setFilter(event.target.value)} placeholder="Try taxi, groceries or dining"/><div className="transaction-list">{transactions.length ? transactions.map(tx => <div className="transaction-row" key={tx.id}><span className="category-icon"><Icon name={tx.category}/></span><div className="transaction-description"><strong>{tx.merchant}</strong><small>{tx.booked_on} · {labels[tx.category] ?? tx.category} · {tx.economic_flow === "internal_transfer" ? "Own-account transfer" : basketLabels[tx.basket]}</small></div><strong className={tx.amount_minor > 0 ? "positive" : ""}>{tx.amount_minor > 0 ? "+" : "−"}{money(Math.abs(tx.amount_minor))}</strong></div>) : <p className="empty-state">No matching transactions in these demo accounts for October 2026.</p>}</div><p className="fine-print">Own-account transfers are shown for evidence and excluded from spending totals. This small development fixture is not the organizer dataset.</p></section>}
          {view === "scenario" && <section className="panel scenario-section"><div className="section-heading"><h2>What if you dined out a little less?</h2><span className="estimate-label">Scenario</span></div><p>Your complete October demo baseline is <strong>{money(scenario.baseline_minor)}</strong>. Try a reduction and see what it could mean.</p><div className="allocation-control"><label htmlFor="reduction">Reduce dining out by <strong>{percent}%</strong></label><input id="reduction" type="range" min="0" max="100" step="5" value={percent} onChange={event => setPercent(Number(event.target.value))} disabled={!online || loading}/><div className="range-labels"><span>0%</span><span>100%</span></div></div><div className="scenario-results" aria-live="polite"><div><span>Potential monthly reduction</span><strong>{scenarioBusy ? "Calculating?" : money(scenario.monthly_reduction_minor)}</strong></div><div><span>If repeated for 12 months</span><strong>{scenarioBusy ? "Calculating?" : money(scenario.total_reduction_minor)}</strong></div></div><p className="learning-note">{scenario.assumption} Actual money available for saving still depends on your other obligations. This scenario does not change transactions or reserve savings.</p></section>}
          {view === "sources" && <section className="panel"><h2>Built on evidence, step by step.</h2><p>This first working slice includes a typed API, fixed-clock synthetic records, deterministic calculation previews, an installable manifest, and a public offline fallback.</p><dl className="source-list"><div><dt>Transactions and balances</dt><dd>Synthetic fixture {profile.fixture_version}, observed 4 November 2026. No organizer dataset is imported.</dd></div><div><dt>Multi-bank support</dt><dd>Two synthetic account sources are displayed. Consent lifecycle, reconciliation, and provider adapters are still planned.</dd></div><div><dt>Statistics Finland</dt><dd>Required release scope. A verified public snapshot and compatible comparisons are not integrated yet.</dd></div><div><dt>Conversational AI</dt><dd>The current question preview uses explicit demo rules. A model-backed, authorized tool flow is still planned.</dd></div><div><dt>PWA lifecycle</dt><dd>Manifest, install support and public offline shell are implemented in this slice. Complete update, push, session isolation and device acceptance remain tracked tasks.</dd></div></dl></section>}
        </>}
        <footer className="page-footer"><span>Money Coach · Personal Economic Trainer</span><span>Educational synthetic demo · Your next decision, made clearer.</span><LegalLinks/></footer>
      </main>
    </div>
  </div>;
}
