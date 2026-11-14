"use client";

import {useCallback, useEffect, useRef, useState,type ReactNode} from "react";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {Button} from "@/components/ui/button";
import {useCopy} from "@/i18n/context";
import {firstBankCopy} from "../i18n/first-bank";
import {matchesBank} from "../lib/bank-search";
import {BankPicker,preferredBankCountry} from "./first-bank";
import {nativeMoney} from "./import-files";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "@/components/ui/drawer";

type Institution = {name:string;country:string};
type Connection = {mode:"live"|"sandbox";id:string;name:string;country:string;consent_state:string;account_count:number;
  expires_at:string|null;last_success_at:string|null;sync_health:string;last_error_code:string|null;revocation_confirmed:boolean|null};
type ImportState={retry_not_before?:string|null;retry_after_known?:boolean;retry_exhausted?:boolean;
  import_in_progress?:boolean;last_error_stage?:string|null;provider_error_code?:string|null;error_observed_at?:string|null};
type LiveRefresh = {account_count:number;booked_transactions:number;observed_at:string;coverage:"partial";notice:string};
type Data={accounts:{id:string;name:string;currency:string;included:boolean;amount_minor:number|null;balance_kind:string|null;observed_at:string|null}[];transactions:{id:string;amount_minor:number;currency:string;booked_on:string;merchant:string;category:string;basket:string;economic_flow:string}[]};
const amount=(minor:number,currency="EUR")=>nativeMoney(minor,currency);
const asDate=(value:string|null)=>value?new Intl.DateTimeFormat("en-GB",{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Tallinn"}).format(new Date(value)):"Never";
const daysUntil=(value:string|null,now:number)=>value===null?null:Math.ceil((new Date(value).getTime()-now)/86400000);
const plainError=(code:string|null)=>code==="BANK_CONSENT_EXPIRED"?"Your bank consent has expired. Reconnect to continue.":code==="BANK_PROVIDER_UNAVAILABLE"?"The bank is temporarily unavailable. Try again later.":code==="BANK_ACCOUNT_ACCESS_REQUIRED"?"This account is no longer available for analysis. Review consent.":"The bank connection needs attention.";

export function LiveBankWorkspace({request,changed,children}:{request:PrivateRequest;changed:()=>void;children?:ReactNode}) {
  const {locale}=useCopy(),copy=firstBankCopy[locale];
  const [flow,setFlow]=useState(false),[choice,setChoice]=useState<Institution|null>(null);
  const [returnId,setReturnId]=useState<string|null>(null),[imported,setImported]=useState<LiveRefresh|null>(null);
  const [countryReady,setCountryReady]=useState(false);
  const [environment,setEnvironment]=useState("");
  const [country,setCountry]=useState("EE");
  const [institutions,setInstitutions]=useState<Institution[]>([]);
  const [connections,setConnections]=useState<(Connection&ImportState)[]>([]);
  const [now,setNow]=useState(()=>Date.now());
  const [filter,setFilter]=useState("");
  const [busy,setBusy]=useState(false);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [accessDenied,setAccessDenied]=useState(false);
  const [accessRequired,setAccessRequired]=useState(false);
  const [notice,setNotice]=useState("");
  const [confirm,setConfirm]=useState<string|null>(null);
  const [available,setAvailable]=useState(true);
  const [detail,setDetail]=useState<{id:string;data:Data}|null>(null);
  const [selected,setSelected]=useState<(Connection&ImportState)|null>(null);
  const [pastOpen,setPastOpen]=useState(false),[infoOpen,setInfoOpen]=useState(false);
  const locked=useRef(false);
  const current=useRef(0);
  const directory=useRef(new Map<string,Institution[]>());
  const alive=useRef(true);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const load=useCallback(async()=>{
    if(!countryReady)return;
    const version=++current.current;
    setLoading(true);setError("");setAccessRequired(false);
    try {
      const capability=await request<{enabled:boolean;environment:string}>("live-banking/capabilities",undefined,{timeoutMs:10000});
      if(!alive.current || version!==current.current)return;
      setEnvironment(capability.environment);
      if(!capability.enabled){setAvailable(false);setInstitutions([]);setConnections([]);return;}
      const directoryKey=`${capability.environment}:${country}`;
      const [banks,existing]=await Promise.all([
        directory.current.has(directoryKey)?Promise.resolve(directory.current.get(directoryKey)!):request<Institution[]>(`live-banking/institutions?country=${country}`,undefined,{timeoutMs:10000}),
        request<(Connection&ImportState)[]>("live-banking/connections",undefined,{timeoutMs:10000})]);
      if(!alive.current || version!==current.current)return;
      directory.current.set(directoryKey,banks);
      setInstitutions(banks);setConnections(existing);setError("");setAccessDenied(false);setAvailable(true);
    } catch(reason){
      if(!alive.current||version!==current.current||aborted(reason))return;
      setAccessDenied(reason instanceof PrivateApiError&&reason.code==="BANK_PROVIDER_ACCESS_DENIED");
      setAccessRequired(reason instanceof PrivateApiError&&["UNAUTHENTICATED","SESSION_CHANGED","FORBIDDEN","MEMBERSHIP_UNAVAILABLE","ACCESS_DENIED"].includes(reason.code));
      if(reason instanceof PrivateApiError && reason.code==="LIVE_BANKS_DISABLED"){
        setAvailable(false);setInstitutions([]);setConnections([]);setError("");
      }else setError("Could not load the bank directory. Check your identity, provider configuration and connectivity.");
    }finally{if(alive.current&&version===current.current)setLoading(false);}
  },[request,country,countryReady]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;};},[load]);
  useEffect(()=>{const query=new URLSearchParams(window.location.search),status=query.get("live_status");
    setCountry(preferredBankCountry());setCountryReady(true);
    setFlow(query.get("connect")==="1"||Boolean(status));setReturnId(query.get("connection"));
    if(status==="failed")setNotice("The returned bank authorization could not be verified. Choose your bank to try again.");
    if(status==="denied")setNotice(copy.cancelled);
  },[copy.cancelled]);
  const execute=async (operation:"connect"|"refresh"|"disconnect"|"inspect",payload:{name?:string;id?:string})=>{
    if(locked.current)return;
    locked.current=true;
    setBusy(true);setError("");setAccessDenied(false);setNotice("");
    try{
      if(operation==="inspect"){const data=await request<Data>(`live-banking/connections/${payload.id}/data`);if(alive.current)setDetail({id:payload.id!,data});return;}
      if(operation==="connect"){
        const result=await request<{redirect_url:string}>("live-banking/connect",{country,name:payload.name});
        const target=new URL(result.redirect_url);
        if(target.protocol!=="https:"||!(target.hostname==="enablebanking.com"||target.hostname.endsWith(".enablebanking.com"))||target.username||target.password||(target.port!==""&&target.port!=="443"))
          throw new Error("Bank authorization URL was not trusted.");
        if(!alive.current)return;
        // Full-page navigation is essential for the bank's mobile strong authentication.
        // No session header or JWT is sent to the bank.
        window.location.assign(target.href);return;
      }
      if(operation==="refresh"){
        const result=await request<LiveRefresh|{state:"in_progress";notice:string}>(`live-banking/connections/${payload.id}/refresh`,{});
        if(!alive.current)return;
        if("state" in result){setNotice(result.notice);setConnections(await request<(Connection&ImportState)[]>("live-banking/connections"));return;}
        setImported(result);setReturnId(payload.id!);setFlow(true);
        setDetail(null);
        setNotice(`Imported ${result.booked_transactions} booked entries across ${result.account_count} account(s), observed ${asDate(result.observed_at)}. ${result.notice || "Coverage is partial; do not treat it as a guaranteed safe-to-spend budget."}`);
      }else{
        const result=await request<Connection>(`live-banking/connections/${payload.id}/disconnect`,{});
        if(!alive.current)return;
        setDetail(null);
        setNotice(result.revocation_confirmed ? "Local access revoked and provider revocation confirmed. Historical records are retained; deletion is a separate operator-assisted process." : "Local access is blocked. Provider revocation is unconfirmed; retry disconnect or revoke consent at your bank. Retained records have not been deleted.");
        setConfirm(null);
      }
      changed();await load();
    }catch(reason){
      if(alive.current&&!aborted(reason))setAccessDenied(reason instanceof PrivateApiError&&reason.code==="BANK_PROVIDER_ACCESS_DENIED");
      if(alive.current&&!aborted(reason)) setError(reason instanceof PrivateApiError ? reason.message : "The bank operation could not be confirmed. Review the connection state before retrying.");
      if(operation==="refresh" && alive.current && !aborted(reason)){
        try{const latest=await request<(Connection&ImportState)[]>("live-banking/connections");if(alive.current)setConnections(latest);}
        catch{/* Preserve the original error; status can be checked explicitly. */}
      }
    }finally{locked.current=false;if(alive.current)setBusy(false);}
  };
  const filtered=institutions.filter(bank=>matchesBank(bank,filter));
  const seen=new Set<string>();
  const visibleConnections=connections.filter(bank=>{
    const key=`${bank.country}:${bank.name}`;
    if(["revoked","denied"].includes(bank.consent_state)||seen.has(key)) return false;
    seen.add(key);return true;
  });
  const pastConnections=connections.filter(bank=>["revoked","denied"].includes(bank.consent_state)||connections.findIndex(other=>other.country===bank.country&&other.name===bank.name)!==connections.indexOf(bank));
  const focused=connections.find(bank=>bank.id===returnId && bank.consent_state==="active");
  const blocked=(bank:Connection&ImportState)=>busy||!!bank.retry_exhausted||!!bank.import_in_progress||Boolean(bank.retry_not_before&&new Date(bank.retry_not_before).getTime()>now);
  const history=new URLSearchParams({start:new Date(Date.now()-90*86400000).toISOString().slice(0,10),end:new Date(Date.now()+86400000).toISOString().slice(0,10)});
  const cooldown=focused?.retry_not_before&&new Date(focused.retry_not_before).getTime()>now;
  if(!available&&!loading)return <section className="space-y-4"><h1 className="text-xl font-semibold">{copy.demoBank}</h1><p className="text-sm text-ink-2">{copy.unavailable}</p><Button asChild className="w-full"><a href="/demo/banks">{copy.demoBank}</a></Button><Button asChild variant="outline" className="w-full"><a href="/demo?dataset=organizer1">{copy.demo}</a></Button></section>;
  if(flow||(!loading&&connections.length===0))return <div className="space-y-6" data-bank-onboarding>
    <p className="text-caption text-ink-2">{environment==="production"?"LIVE":environment==="sandbox"?"PROVIDER SANDBOX":"Checking bank access…"} · Money Coach · EUR · AIS</p>
    {focused?<section className="space-y-4" aria-busy={busy}>
      <h1 className="text-xl font-semibold">{copy.connected.replace("{bank}",focused.name)}</h1>
      {imported?<><p role="status" className="text-sm">{imported.booked_transactions?copy.result.replace("{count}",String(imported.booked_transactions)):copy.none}</p><Button asChild className="w-full"><a href={`/transactions?${history}`}>{copy.view}</a></Button></>:<>
        {error&&<p role="alert" className="text-sm text-neg">{accessDenied?copy.providerDenied:error}</p>}
        {cooldown&&<p role="status" className="text-sm text-ink-2">{copy.wait} {focused.retry_after_known?asDate(focused.retry_not_before!):`${copy.unknownWait} ${asDate(focused.retry_not_before!)}`}</p>}
        {focused.retry_exhausted&&<p role="status" className="text-sm text-ink-2">{copy.paused}</p>}
        {focused.import_in_progress&&<p role="status" className="text-sm text-ink-2">{copy.running}</p>}
        <Button className="w-full" disabled={blocked(focused)} onClick={()=>void execute("refresh",{id:focused.id})}>{busy?copy.importing:copy.import}</Button>
        {(focused.import_in_progress||cooldown||focused.last_error_code)&&<Button variant="outline" className="w-full" disabled={busy||loading} onClick={()=>void load()}>{copy.status}</Button>}
      </>}
    </section>:choice?<section className="space-y-4"><h1 className="text-xl font-semibold">{choice.name}</h1><p className="text-sm text-ink-2">{copy.consent}</p>{error&&<p role="alert" className="text-sm text-neg">{accessDenied?copy.providerDenied:error}</p>}<Button className="w-full" disabled={busy} onClick={()=>void execute("connect",{name:choice.name})}>{copy.continue.replace("{bank}",choice.name)}</Button><Button variant="outline" className="w-full" disabled={busy} onClick={()=>setChoice(null)}>{copy.back}</Button></section>:<>
      {notice&&<p role="status" className="text-sm text-ink-2">{notice}</p>}
      <BankPicker country={country} onCountry={value=>{setLoading(true);setInstitutions([]);setCountry(value);}} filter={filter} onFilter={setFilter} banks={filtered} loading={loading} error={error?(accessRequired?copy.accessRequired:accessDenied?copy.providerDenied:copy.failed):""} retry={()=>void load()} choose={setChoice}/>
    </>}
    {accessRequired&&<Button asChild variant="outline" className="w-full"><a href="/api/v1/auth/login?prompt=login">{copy.signIn}</a></Button>}
    {accessDenied&&<div className="space-y-3"><Button asChild variant="outline" className="w-full"><a href="/demo/banks">{copy.demoBank}</a></Button></div>}
    <div className="grid gap-3">{visibleConnections.length>0&&<Button variant="outline" onClick={()=>{setFlow(true);setReturnId(null);setImported(null);setChoice(null);window.history.replaceState(null,"","/banks?connect=1");}}>{copy.add}</Button>}<Button asChild variant="link"><a href="/">{copy.back}</a></Button></div>
  </div>;
  return <>
    <div className="page-heading"><div><h1>Your banks, securely connected.</h1><p>Read-only account data from your bank, with your explicit consent.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span><strong>{environment==="production" ? "LIVE" : "PROVIDER SANDBOX"}</strong> · Verified users only · No payments, transfers or bank passwords in Money Coach.</span></p>
    {loading&&<p role="status" className="loading-state">Checking the provider directory…</p>}
    {error&&<p role="alert" className="error-notice">{accessDenied?copy.providerDenied:error}</p>}
    {notice&&<p role="status" className="bank-feedback">{notice}</p>}
    {!available&&<section className="panel bank-section"><h2>Live banking is not configured on this deployment</h2>
      <p>Sandbox and synthetic demos still work. Live Banking requires a registered Enable Banking application, a private RSA key, encrypted credential storage, a migrated database and verified OIDC login.</p>
      <a className="secondary-button" href="/demo?dataset=organizer1">Explore the public demo</a></section>}
    {available&&!loading&&<>
      <section className="panel bank-section"><div className="review-account-heading"><h2>Your connected banks</h2><button className="secondary-button" disabled={busy} onClick={()=>void load()}>Update status</button></div>
        {visibleConnections.length===0?<p className="bank-empty">No bank consent has been confirmed yet. Choose an institution below.</p>:<ul className="bank-list">{visibleConnections.map(bank=><li className="bank-row" key={bank.id}>
          <div className="review-account-heading"><h3><button className="min-h-12 text-left" onClick={()=>setSelected(bank)}>{bank.name} ···{bank.id.slice(-4)}</button></h3><span className="bank-state">{bank.consent_state}</span></div>
          <p className="field-hint">Updated {bank.last_success_at?asDate(bank.last_success_at):"never"} · {daysUntil(bank.expires_at,now)===null?"Consent expiry unknown":`${daysUntil(bank.expires_at,now)} days until consent expires`}</p>
          <p className="bank-health">{bank.sync_health==="partial"?"Partial history — not a complete safe-to-spend assessment":bank.sync_health}</p>
          {bank.last_error_code&&<p className="bank-source-warning">{plainError(bank.last_error_code)}</p>}
          {bank.retry_not_before&&<p role="status" className="field-hint">{bank.retry_after_known?"Provider Retry-After":"Bank limit end unknown. Money Coach precautionary pause"}: {asDate(bank.retry_not_before)}. {bank.retry_exhausted?"Further attempts are paused for review.":new Date(bank.retry_not_before).getTime()>now?"No bank requests while waiting.":"One manual retry is available; no automatic import will run."}</p>}
          {bank.retry_exhausted&&<p role="status" className="bank-source-warning">Three limited attempts. Further imports need operator review; your bank consent is preserved.</p>}
          {bank.import_in_progress&&<p role="status" className="field-hint">One import is already running for all {bank.account_count} selected accounts. Use Update status after it finishes.</p>}
          <div className="plan-actions">
            {bank.consent_state==="active"&&<button className="primary-button" disabled={busy||bank.retry_exhausted||bank.import_in_progress||Boolean(bank.retry_not_before&&new Date(bank.retry_not_before).getTime()>now)} onClick={()=>void execute("refresh",{id:bank.id})}>Import recent transactions</button>}
            {bank.consent_state==="active"&&<button className="secondary-button" disabled={busy} onClick={()=>void execute("inspect",{id:bank.id})}>View imported accounts</button>}
            {["expired","revoked","denied"].includes(bank.consent_state)&&<button className="secondary-button" disabled={busy} onClick={()=>{setCountry(bank.country);setFilter(bank.name);setChoice({name:bank.name,country:bank.country});setFlow(true);}}>Reconnect</button>}
            {(bank.consent_state!=="revoked" || bank.revocation_confirmed===false)&&<button className="text-button" disabled={busy} onClick={()=>setConfirm(bank.id)}>Disconnect</button>}
          </div>
          {confirm===bank.id&&<div className="bank-disconnect"><p>Revoke this read-only bank session? Previously imported records are retained until separately deleted.</p>
            <div className="plan-actions"><button className="secondary-button" disabled={busy} onClick={()=>void execute("disconnect",{id:bank.id})}>Confirm revoke</button><button className="text-button" disabled={busy} onClick={()=>setConfirm(null)}>Cancel</button></div></div>}
          {detail?.id===bank.id&&<section className="bank-accounts" aria-label="Imported bank data"><h4>Accounts and observed balances</h4><ul className="bank-list">{detail.data.accounts.map(account=><li key={account.id} className="bank-row"><strong>{account.name}</strong><span className="bank-account-meta">{account.included ? account.amount_minor===null ? "No balance observation" : `${amount(account.amount_minor,account.currency)} (${account.balance_kind})` : "Excluded from analysis"}</span><span className="field-hint">{asDate(account.observed_at)}</span></li>)}</ul><h4>Latest imported transactions</h4><ul className="bank-list">{detail.data.transactions.map(row=><li key={row.id} className="bank-row"><strong>{row.merchant}</strong><p>{amount(row.amount_minor,row.currency)}</p><span className="bank-account-meta">{row.booked_on} / {row.category} / {row.basket} / {row.economic_flow}</span></li>)}</ul><p className="field-hint">Up to 50 entries. Unknown transfers and credits need review; these are not complete historical totals.</p><a className="secondary-button" href="/analysis">Ask about these transactions</a></section>}
        </li>)}</ul>}
      </section>
      {pastConnections.length>0&&<><button className="secondary-button" onClick={()=>setPastOpen(true)}>Past connections</button><Drawer open={pastOpen} onOpenChange={setPastOpen}><DrawerContent><DrawerHeader><DrawerTitle>Past connections</DrawerTitle></DrawerHeader><ul className="divide-y divide-line px-4 pb-4">{pastConnections.map(bank=><li className="py-3" key={bank.id}>{bank.name} ···{bank.id.slice(-4)}<span className="ml-2 bank-state">{bank.consent_state}</span><Button variant="outline" className="mt-3 w-full" onClick={()=>{setPastOpen(false);setCountry(bank.country);setChoice({name:bank.name,country:bank.country});setFlow(true);}}>Reconnect</Button></li>)}</ul></DrawerContent></Drawer></>}
      <button className="secondary-button" onClick={()=>{setFlow(true);setChoice(null);}}>Add another bank</button>
      <section className="panel bank-section"><h2>What happens next?</h2><button className="secondary-button" onClick={()=>setInfoOpen(true)}>Read the short version</button>
        <p className="field-hint">A successful bank authentication does not prove full historical coverage. Imported data may contain uncategorised payments. Currency support in this pilot is currently EUR only.</p></section>
      <Drawer open={Boolean(selected)} onOpenChange={open=>{if(!open)setSelected(null);}}><DrawerContent><DrawerHeader><DrawerTitle>{selected?.name} ···{selected?.id.slice(-4)}</DrawerTitle>      <DrawerDescription>{selected?.last_error_code?plainError(selected.last_error_code):copy.consent}</DrawerDescription>{selected?.last_error_code&&<p className="text-caption">Technical details: {selected.last_error_code}</p>}</DrawerHeader><div className="space-y-3 px-4 pb-4">{selected&&<><button className="primary-button w-full" disabled={selected?blocked(selected):true} onClick={()=>void execute("refresh",{id:selected.id})}>Update now</button><button className="secondary-button w-full" disabled={busy} onClick={()=>void execute("inspect",{id:selected.id})}>View accounts</button><button className="secondary-button w-full" onClick={()=>{setCountry(selected.country);setFilter(selected.name);setChoice({name:selected.name,country:selected.country});setFlow(true);setSelected(null);}}>Reconnect</button><button className="text-button w-full" disabled={busy} onClick={()=>setConfirm(selected.id)}>Disconnect</button>{confirm===selected.id&&<div className="bank-disconnect"><p>Disconnect this bank? Imported records are retained.</p><button className="secondary-button" onClick={()=>void execute("disconnect",{id:selected.id})}>Confirm disconnect</button></div>}</>}</div><DrawerFooter><DrawerClose asChild><button className="secondary-button">Done</button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
      <Drawer open={infoOpen} onOpenChange={setInfoOpen}><DrawerContent><DrawerHeader><DrawerTitle>What happens next?</DrawerTitle></DrawerHeader><div className="px-4 pb-6 text-sm"><p>After bank consent, recent read-only transactions are imported. Incomplete history or uncategorised payments keep spending guidance cautious.</p></div></DrawerContent></Drawer>
    </>}
    {children}
  </>;
}
