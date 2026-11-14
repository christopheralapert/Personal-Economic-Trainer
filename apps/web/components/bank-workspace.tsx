"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import type {components} from "@contracts";
import {aborted, PrivateApiError, type PrivateRequest,type PrivateTransfer} from "./private-session";
import {ImportWorkspace} from "./import-workspace";

type Schema = components["schemas"];
type Connection = Schema["BankConnectionV1"];
type Authorization = Schema["BankAuthorizationResultV1"];
type Snapshot = {banks: Schema["BankCapabilitiesV1"][]; connections: Connection[]; accounts: Schema["AccountWithSourceV1"][]};
type Command =
  | {kind:"start"; path:string; body:Schema["StartBankConsentV1"]}
  | {kind:"complete"; path:string; body:Schema["CompleteBankConsentV1"]}
  | {kind:"refresh"; path:string; body:Schema["RefreshBankV1"]}
  | {kind:"disconnect"; path:string; body:Record<string,never>};

const consentLabels = {requested:"Awaiting consent",authorizing:"Choose accounts",active:"Access granted",expired:"Access expired",revoked:"Disconnected",denied:"Access declined"};
const healthLabels = {never_synced:"Not refreshed yet",syncing:"Refresh queued or running",staged:"Fetched; publication pending",fresh:"Published observation",stale:"Observation needs refreshing",partial:"Incomplete source",error:"Refresh needs attention"};
const date = (value: string | null) => value ? new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/Helsinki",day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value)) : "Not available";
const day = (value: string) => new Intl.DateTimeFormat("en-GB", {timeZone:"Europe/Helsinki",day:"numeric",month:"short",year:"numeric"}).format(new Date(`${value}T12:00:00+02:00`));
const active = (connection: Connection, now: number) => connection.consent_state === "active" && !!connection.expires_at && new Date(connection.expires_at).getTime() > now;

function failure(reason: unknown) {
  if (reason instanceof PrivateApiError) {
    if (reason.code.toLowerCase().includes("throttled")) return "Refresh requests are limited. Wait at least a minute, then retry the same request.";
    if (["BANK_AUTH_EXPIRED","BANK_CALLBACK_REJECTED","BANK_AUTH_SESSION_CHANGED"].includes(reason.code)) return "This consent can no longer be completed here. Cancel the unfinished connection, then connect again.";
    if (reason.code === "BANK_CONNECTION_EXISTS") return "This bank already has an open connection. Reload its status before connecting again.";
    if (reason.code === "SYNTHETIC_BANKS_ONLY") return "Bank simulators are available only to synthetic development profiles.";
    return reason.message;
  }
  return "The response could not be confirmed. Retry the same request before making another change.";
}

export function BankWorkspace({request,transfer, changed}: {request: PrivateRequest;transfer:PrivateTransfer; changed: () => void}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [authorization, setAuthorization] = useState<Authorization | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [pending, setPending] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [polling, setPolling] = useState(false);
  const [filesOpen,setFilesOpen]=useState(false);
  const latest = useRef(0);
  const mounted = useRef(true);
  const commandLock = useRef(false);
  const pollBudget = useRef(0);
  const published = useRef("");
  const consentHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => { if (authorization) consentHeading.current?.focus(); },[authorization]);

  const load = useCallback(async () => {
    const revision = ++latest.current;
    try {
      const [banks, connections, accounts] = await Promise.all([
        request<Snapshot["banks"]>("banks"), request<Connection[]>("bank-connections"), request<Snapshot["accounts"]>("accounts/sources"),
      ]);
      if (!mounted.current || revision !== latest.current) return;
      const observations = JSON.stringify(accounts.map(account => [account.id,account.source?.source_version,account.source?.granted]));
      if (published.current && published.current !== observations) changed();
      published.current = observations;
      setSnapshot({banks, connections, accounts}); setError("");
      setPolling(connections.some(connection => ["syncing","staged"].includes(connection.sync_health) && active(connection,Date.now())));
    } catch (reason) {
      if (!aborted(reason) && mounted.current && revision === latest.current) {
        setSnapshot(null); setPolling(false); setError(failure(reason));
      }
    } finally { if (mounted.current && revision === latest.current) setLoading(false); }
  }, [request,changed]);
  const importChanged=useCallback(()=>{changed();void load();},[changed,load]);

  useEffect(() => {
    mounted.current = true; pollBudget.current = 12;
    void load();
    const clock = window.setInterval(() => setNow(Date.now()),1000);
    return () => {mounted.current = false; latest.current += 1; window.clearInterval(clock);};
  }, [load]);

  useEffect(() => {
    if (!polling) return;
    const timer = window.setTimeout(() => {
      if (pollBudget.current-- > 0) void load();
      else {setPolling(false); setNotice("The refresh is still pending. Check status again shortly. A fetched source is usable only after publication succeeds.");}
    },5000);
    return () => window.clearTimeout(timer);
  }, [polling,snapshot,load]);

  const execute = async (command: Command) => {
    if (commandLock.current) return;
    commandLock.current = true; setBusy(true); setPending(command); setError(""); setNotice("");
    try {
      if (command.kind === "start") {
        const result = await request<Authorization>(command.path,command.body);
        if (!mounted.current) return;
        setAuthorization(result.authorization && result.state_token ? result : null); setSelected([]);
        setNotice(result.authorization ? "Choose which accounts to share below." : "This consent request has already ended. Review its current status below.");
      } else if (command.kind === "refresh") {
        const result = await request<Schema["BankRefreshResultV1"]>(command.path,command.body);
        if (!mounted.current) return;
        setNotice(result.financial_publication_complete ? "This refresh was published. Review the dated account observations below." : "Refresh accepted. Fetching and publication run in the background; this is not yet a new financial observation.");
        pollBudget.current = 12;
      } else {
        const result = await request<Connection>(command.path,command.body);
        if (!mounted.current) return;
        setAuthorization(null); setSelected([]); setConfirm(null);
        setNotice(result.consent_state === "active" ? "Account access granted. Refresh this bank to publish its first observation." : result.consent_state === "denied" ? "Access declined. No accounts were shared." : "Connection closed. Retained records remain, but this consent no longer grants financial access. Existing savings reservations can still be released from your plan.");
      }
      setPending(null); changed(); await load();
    } catch (reason) {
      if (!aborted(reason) && mounted.current) {
        setError(failure(reason));
        // Definite API rejections do not leave an unknown write to repeat.
        // Transport failures keep the exact original path, body and key.
        if (reason instanceof PrivateApiError && ["BANK_CONNECTION_EXISTS","BANK_AUTH_EXPIRED","BANK_CALLBACK_REJECTED","BANK_AUTH_SESSION_CHANGED","BANK_INVALID_SELECTION","INVALID_REQUEST","BANK_CONSENT_NOT_ACTIVE","BANK_CONNECTION_LIMIT","SYNTHETIC_BANKS_ONLY","REFRESH_THROTTLED"].includes(reason.code)) setPending(null);
      }
    } finally { commandLock.current = false; if (mounted.current) setBusy(false); }
  };

  const complete = (approved: boolean) => {
    if (!authorization?.state_token) return;
    void execute({kind:"complete",path:`bank-connections/${authorization.connection.id}/complete`,body:{key:crypto.randomUUID(),state_token:authorization.state_token,approved,account_references:approved ? [...selected] : []}});
  };
  const locked = busy || pending !== null;
  const consentExpired = !authorization?.authorization || new Date(authorization.authorization.expires_at).getTime() <= now;

  return <>
    <div className="page-heading"><div><h1>Your banks, in one place.</h1><p>Choose account access and see when each source was actually observed.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>Synthetic bank simulators. No real bank login, payment or transfer is used.</span></p>
    {loading && <p className="loading-state" role="status">Loading your bank connections…</p>}
    {error && <div className="error-notice" role="alert"><span>{error}</span></div>}
    {pending && !busy && <div className="plan-blockers"><p>The last change is unconfirmed. Its original request is kept in this window.</p><button className="secondary-button" onClick={() => void execute(pending)}>Retry the same bank request</button></div>}
    <p className="bank-feedback" role="status">{busy ? "Confirming your bank request…" : notice}</p>
    {!loading && <div className="plan-actions bank-status-actions"><button className="secondary-button" disabled={busy} onClick={() => {pollBudget.current=12; void load();}}>Check bank status</button><a href="/plan">Open your reviewed plan</a></div>}
    <details className="panel bank-section import-entry" open={filesOpen} onToggle={event=>setFilesOpen(event.currentTarget.open)}>
      <summary><h2>Your data files</h2><span>Import or revisit your synthetic exports</span></summary>
      {filesOpen && <ImportWorkspace request={request} transfer={transfer} changed={importChanged}/>}
    </details>
    {authorization?.authorization && <section className="panel review-panel bank-consent" aria-labelledby="consent-heading">
      <h2 id="consent-heading" ref={consentHeading} tabIndex={-1}>Choose accounts for {authorization.connection.name}</h2>
      <p>{authorization.authorization.notice}</p>
      <p className="field-hint">Read-only access to selected account balances and transaction history. This choice expires {date(authorization.authorization.expires_at)} (Helsinki).</p>
      {consentExpired && <p className="plan-blockers" role="alert">This choice expired. Cancel the unfinished connection below and connect again.</p>}
      <fieldset disabled={locked || consentExpired}>
        <legend>Accounts to share</legend>
        {authorization.authorization.available_accounts.map(account => <label className="check-field" key={account.reference}>
          <input type="checkbox" checked={selected.includes(account.reference)} onChange={event => setSelected(current => event.target.checked ? [...current,account.reference] : current.filter(value => value!==account.reference))}/>
          <span>{account.name}<small className="bank-account-meta">{account.currency} · {account.account_type} account</small></span>
        </label>)}
      </fieldset>
      <div className="plan-actions"><button className="primary-button" disabled={locked || consentExpired || selected.length===0} onClick={() => complete(true)}>Allow selected accounts</button><button className="secondary-button" disabled={locked || consentExpired} onClick={() => complete(false)}>Decline account access</button></div>
    </section>}
    {snapshot && <>
      <section className="panel bank-section" aria-labelledby="connections-heading">
        <h2 id="connections-heading">Bank connections</h2>
        <p className="field-hint">Access and source freshness are separate. Refreshing one bank does not verify your complete financial situation.</p>
        {snapshot.connections.length === 0 ? <p className="bank-empty">No bank is connected yet. Choose a simulator below, approve its account access, then refresh its observation.</p> : <ul className="bank-list">
          {snapshot.connections.map(connection => {
            const granted = active(connection,now);
            const state = connection.consent_state === "active" && !granted ? "expired" : connection.consent_state;
            const canClose = !["revoked","denied"].includes(state);
            const accounts = snapshot.accounts.filter(account => account.source?.connection_id === connection.id);
            return <li key={connection.id} className="bank-row">
              <div className="review-account-heading"><h3>{connection.name}</h3><span className="bank-state">{consentLabels[state]}</span></div>
              <p className="field-hint">{granted ? `${connection.account_references.length} account(s) allowed · Access expires ${date(connection.expires_at)} (Helsinki)` : "This connection cannot provide current financial access."}</p>
              <p className="bank-health">{granted ? healthLabels[connection.sync_health] : "Retained connection history"}</p>
              {granted && ["syncing","staged"].includes(connection.sync_health) && <p className="field-hint">A background refresh must finish fetching and publication. Check status to see its result.</p>}
              {connection.last_error_code && <p className="bank-source-warning">The source could not be refreshed completely. The previous observation has not been advanced. Check access and retry refresh.</p>}
              <dl className="bank-evidence"><div><dt>Last successful publication</dt><dd>{date(connection.last_success_at)}{connection.last_success_at && " (Helsinki)"}</dd></div></dl>
              {accounts.length>0 ? <ul className="bank-accounts">{accounts.map(account => <li key={account.id}>
                <strong>{account.name}</strong><span className="bank-account-meta">{account.currency} · {account.included ? "Included in planning" : "Outside planning scope"}</span>
                <dl className="bank-evidence"><div><dt>Published source observed</dt><dd>{date(account.source!.observed_at)}{account.source!.observed_at && " (Helsinki)"}</dd></div><div><dt>Published history window</dt><dd>{account.source!.history_from && account.source!.history_to_exclusive ? `${day(account.source!.history_from)} until ${day(account.source!.history_to_exclusive)} (end excluded)` : "Not established"}</dd></div><div><dt>Current source status</dt><dd>{account.source!.granted ? healthLabels[account.source!.sync_health] : "Access required"}</dd></div></dl>
                <p className="field-hint">History stops at the actual observation, even if its date window extends later. This does not establish whole-finance or household coverage.</p>
              </li>)}</ul> : <p className="field-hint">No published account source is attached to this connection.</p>}
              {state === "authorizing" && authorization?.connection.id !== connection.id && <p className="bank-source-warning">This consent choice is not open in this window. Cancel the unfinished connection before starting again.</p>}
              <div className="plan-actions">{granted && <button className="secondary-button" disabled={locked} onClick={() => void execute({kind:"refresh",path:`bank-connections/${connection.id}/refresh`,body:{key:crypto.randomUUID()}})}>Refresh {connection.name}</button>}
                {canClose && <button className="text-button" disabled={locked} onClick={() => setConfirm(connection.id)}>{state === "authorizing" ? "Cancel unfinished connection" : `Disconnect ${connection.name}`}</button>}
              </div>
              {confirm === connection.id && <div className="bank-disconnect"><p>Close access for {connection.name}? Its financial records will be retained, and new guidance may require a replacement connection.</p><div className="plan-actions"><button className="secondary-button" disabled={locked} onClick={() => void execute({kind:"disconnect",path:`bank-connections/${connection.id}/disconnect`,body:{}})}>Confirm disconnect</button><button className="text-button" disabled={locked} onClick={() => setConfirm(null)}>Keep connection</button></div></div>}
            </li>;
          })}
        </ul>}
      </section>
      <section className="panel bank-section" aria-labelledby="add-bank-heading"><h2 id="add-bank-heading">Add a synthetic bank</h2><p className="field-hint">Each simulator has its own read-only consent and balance semantics. Expired or disconnected access requires a new choice.</p>
        <ul className="bank-list">{snapshot.banks.map(bank => {
          const open = snapshot.connections.some(connection => connection.institution_id===bank.id && (["requested","authorizing"].includes(connection.consent_state) || active(connection,now)));
          return <li key={bank.id} className="bank-row"><h3>{bank.name}</h3><p className="field-hint">{bank.notice}</p><p className="field-hint">{bank.currencies.join(", ")} · {bank.balance_kind === "available" ? "Available balance; pending already reflected" : "Booked balance; pending handled separately"} · Refresh at most every {bank.minimum_refresh_seconds} seconds.</p><div className="plan-actions"><button className="secondary-button" disabled={locked || open || authorization!==null} onClick={() => void execute({kind:"start",path:"bank-connections",body:{key:crypto.randomUUID(),institution_id:bank.id}})}>{open ? `${bank.name} connection open` : `Connect ${bank.name}`}</button></div></li>;
        })}</ul>
      </section>
      {snapshot.accounts.some(account => !account.source) && <section className="bank-section" aria-labelledby="unverified-heading"><h2 id="unverified-heading">Accounts without verified source coverage</h2><p className="field-hint">These retained accounts have no published bank source attached. Their history and freshness are unverified.</p><ul className="bank-list">{snapshot.accounts.filter(account => !account.source).map(account => <li className="bank-row" key={account.id}>{account.name} · {account.currency}</li>)}</ul></section>}
    </>}
  </>;
}
