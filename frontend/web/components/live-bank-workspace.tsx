"use client";

import {useCallback, useEffect, useRef, useState,type ReactNode} from "react";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {Button} from "@/components/ui/button";
import {useCopy} from "@/i18n/context";
import {firstBankCopy} from "../i18n/first-bank";
import {matchesBank} from "../lib/bank-search";
import {BankPicker,preferredBankCountry} from "./first-bank";
import {nativeMoney} from "./import-files";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerBody} from "@/components/ui/drawer";
import {Landmark,Info,History} from "lucide-react";
import {Skeleton} from "@/components/ui/skeleton";
import {InlineError} from "@/components/ui/inline-error";
import {EmptyState} from "@/components/ui/empty-state";
import {SettingsGroup,SettingsSheetRow} from "@/components/settings-list";

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
const errorKey=(code:string|null)=>code==="BANK_CONSENT_EXPIRED"?"bankErrorExpired":code==="BANK_PROVIDER_UNAVAILABLE"?"bankErrorUnavailable":code==="BANK_ACCOUNT_ACCESS_REQUIRED"?"bankErrorAccess":"bankErrorGeneric";
type Status="connected"|"attention"|"expired"|"paused"|"updating"|"never";
const statusOf=(bank:Connection&ImportState):Status=>bank.retry_exhausted?"paused":bank.import_in_progress?"updating":bank.consent_state==="expired"?"expired":bank.last_error_code||bank.sync_health==="failed"||bank.consent_state!=="active"?"attention":!bank.last_success_at?"never":"connected";
const statusKey={connected:"statusConnected",attention:"statusAttention",expired:"statusExpired",paused:"statusPaused",updating:"statusUpdating",never:"statusNever"} as const;
const statusTone:Record<Status,string>={connected:"bg-brand-tint text-active-ink",attention:"bg-basket-surprises/15 text-ink",expired:"bg-basket-surprises/15 text-ink",paused:"bg-tile-grey text-ink-2",updating:"bg-tile-grey text-ink-2",never:"bg-tile-grey text-ink-2"};

export function LiveBankWorkspace({request,changed,children}:{request:PrivateRequest;changed:()=>void;children?:ReactNode}) {
  const {locale,t}=useCopy(),copy=firstBankCopy[locale];
  const [adding,setAdding]=useState(false);
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
  const shortTime=(value:string)=>{const date=new Date(value),today=new Date(now).toDateString()===date.toDateString();return new Intl.DateTimeFormat(locale,today?{hour:"2-digit",minute:"2-digit",timeZone:"Europe/Tallinn"}:{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Tallinn"}).format(date);};
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
      }else setError(t("banksLoadError"));
    }finally{if(alive.current&&version===current.current)setLoading(false);}
  },[request,country,countryReady,t]);
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
        setNotice(t(result.revocation_confirmed ? "disconnectedConfirmed" : "disconnectedUnconfirmed"));
        setConfirm(null);setSelected(null);
      }
      changed();await load();
    }catch(reason){
      if(alive.current&&!aborted(reason))setAccessDenied(reason instanceof PrivateApiError&&reason.code==="BANK_PROVIDER_ACCESS_DENIED");
      if(alive.current&&!aborted(reason)) setError(t("bankActionError"));
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
  if(!available&&!loading)return <section className="space-y-4"><h1 className="text-xl font-semibold">{copy.demoBank}</h1><p className="text-sm text-ink-2">{copy.unavailable}</p><div className="grid gap-3"><Button asChild variant="outline" className="w-full"><a href="/demo/banks">{copy.demoBank}</a></Button><Button asChild variant="outline" className="w-full"><a href="/demo?dataset=organizer1">{copy.demo}</a></Button></div></section>;
  if(flow||(!loading&&connections.length===0))return <div className="space-y-6" data-bank-onboarding>
    <p className="text-caption text-ink-2">{environment ? `${t(environment==="production"?"environmentLive":"environmentSandbox")} · ${t("banksSubtitle")}` : t("banksSubtitle")}</p>
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
  const active=selected?.consent_state==="active";
  const describe=(bank:Connection&ImportState)=>{const status=statusOf(bank);return status==="connected"||status==="never"?t("banksSubtitle"):status==="paused"?t("bankPausedReview"):status==="updating"?t("bankImportRunning"):t(errorKey(bank.last_error_code));};
  return <div className="space-y-6">
    <div className="space-y-1"><h1 className="text-xl font-semibold">{t("banksTitle")}</h1><p className="text-sm text-ink-2">{environment&&<span className="mr-2 rounded-full bg-tile-grey px-2 py-0.5 text-caption text-ink-2">{t(environment==="production"?"environmentLive":"environmentSandbox")}</span>}{t("banksSubtitle")}</p></div>
    {notice&&<p role="status" className="bank-feedback rounded-2xl border border-line bg-surface p-4 text-sm">{notice}</p>}
    {error&&!selected&&<InlineError message={accessDenied?copy.providerDenied:error} onRetry={()=>void load()}/>}
    {loading&&<div role="status" className="space-y-3"><span className="sr-only">{copy.loading}</span><Skeleton className="h-16 w-full rounded-2xl"/><Skeleton className="h-16 w-full rounded-2xl"/></div>}
    {available&&!loading&&<>
      {visibleConnections.length===0?<EmptyState icon={Landmark} title={t("noBanksYet")} action={<Button onClick={()=>setAdding(true)}>{t("addBank")}</Button>}>{t("noBanksNote")}</EmptyState>:
      <ul aria-label={t("banksTitle")} className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{visibleConnections.map(bank=>{const status=statusOf(bank),days=daysUntil(bank.expires_at,now);return <li key={bank.id}><button type="button" className="flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-tile-grey focus-visible:bg-tile-grey" onClick={()=>{setSelected(bank);setConfirm(null);setDetail(null);setError("");}}>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tile-grey text-ink-2" aria-hidden="true"><Landmark className="size-5"/></span>
        <span className="min-w-0 flex-1"><span className="block wrap-anywhere text-base font-medium">{bank.name} ···{bank.id.slice(-4)}</span><span className="block text-caption tabular-nums text-ink-2">{bank.last_success_at?t("updatedAt",{time:shortTime(bank.last_success_at)}):t("statusNever")}{days!==null&&days>=0?` · ${days===0?t("consentEndsToday"):t("consentDaysLeft",{days})}`:""}</span></span>
        <span className={`shrink-0 rounded-full px-2 py-1 text-caption font-medium ${statusTone[status]}`}>{t(statusKey[status])}</span></button></li>;})}</ul>}
      {visibleConnections.length>0&&<Button variant="outline" className="w-full" onClick={()=>setAdding(true)}>{t("addBank")}</Button>}
      <SettingsGroup title={t("settingsAbout")}>
        {pastConnections.length>0&&<SettingsSheetRow label={t("pastConnections")} value={t("pastConnectionsCount",{count:pastConnections.length})}><ul className="divide-y divide-line">{pastConnections.map(bank=><li className="flex min-h-14 items-center gap-3 py-3" key={bank.id}><History className="size-5 shrink-0 text-ink-2" aria-hidden="true"/><span className="min-w-0 flex-1 wrap-anywhere">{bank.name} ···{bank.id.slice(-4)}</span><Button variant="outline" size="chip" onClick={()=>{setCountry(bank.country);setChoice({name:bank.name,country:bank.country});setFlow(true);}}>{t("reconnect")}</Button></li>)}</ul></SettingsSheetRow>}
        <SettingsSheetRow label={t("howBanksWork")}><p className="flex gap-3 text-sm leading-relaxed"><Info className="mt-0.5 size-5 shrink-0 text-ink-2" aria-hidden="true"/><span>{t("howBanksWorkText")}</span></p></SettingsSheetRow>
      </SettingsGroup>
    </>}
    {children}
    <Drawer open={adding} onOpenChange={setAdding}><DrawerContent><DrawerHeader><DrawerTitle>{t("addBank")}</DrawerTitle><DrawerDescription>{t("banksSubtitle")}</DrawerDescription></DrawerHeader><DrawerBody><BankPicker heading={false} country={country} onCountry={value=>{setLoading(true);setInstitutions([]);setCountry(value);}} filter={filter} onFilter={setFilter} banks={filtered} loading={loading} error={error?copy.failed:""} retry={()=>void load()} choose={bank=>{setAdding(false);setChoice(bank);setFlow(true);}}/></DrawerBody></DrawerContent></Drawer>
    <Drawer open={Boolean(selected)} onOpenChange={open=>{if(!open){setSelected(null);setConfirm(null);setDetail(null);}}}><DrawerContent>{selected&&<>
      <DrawerHeader><DrawerTitle>{selected.name} ···{selected.id.slice(-4)}</DrawerTitle><DrawerDescription>{describe(selected)}</DrawerDescription></DrawerHeader>
      <DrawerBody className="space-y-4">
        {selected.retry_not_before&&new Date(selected.retry_not_before).getTime()>now&&<p role="status" className="text-sm text-ink-2">{t("bankWait",{time:shortTime(selected.retry_not_before)})}</p>}
        {error&&<InlineError message={accessDenied?copy.providerDenied:error}/>}
        {detail?.id===selected.id&&<section className="space-y-3" aria-label={t("bankAccounts")}><h3 className="text-sm font-semibold text-ink-2">{t("bankAccounts")}</h3><ul className="divide-y divide-line rounded-2xl border border-line">{detail.data.accounts.map(account=><li key={account.id} className="flex min-h-14 items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1 wrap-anywhere">{account.name}</span><span className="text-right text-sm tabular-nums">{account.included?account.amount_minor===null?t("noBalanceYet"):amount(account.amount_minor,account.currency):t("notInAnalysis")}</span></li>)}</ul>
          <h3 className="text-sm font-semibold text-ink-2">{t("latestTransactions")}</h3><ul className="divide-y divide-line">{detail.data.transactions.slice(0,10).map(row=><li key={row.id} className="flex min-h-14 items-center gap-3 py-2"><span className="min-w-0 flex-1 wrap-anywhere text-sm">{row.merchant}<span className="block text-caption text-ink-2">{row.booked_on}</span></span><span className="text-sm font-semibold tabular-nums">{amount(row.amount_minor,row.currency)}</span></li>)}</ul></section>}
        {confirm===selected.id&&<div className="space-y-3 rounded-2xl bg-tile-grey p-4"><p className="text-sm">{t("disconnectConfirm")}</p><div className="flex flex-wrap gap-3"><Button variant="destructive" disabled={busy} onClick={()=>void execute("disconnect",{id:selected.id})}>{t("confirmDisconnect")}</Button><Button variant="ghost" disabled={busy} onClick={()=>setConfirm(null)}>{t("cancelAction")}</Button></div></div>}
        {selected.last_error_code&&<p className="text-caption text-ink-2">{t("technicalDetail",{code:selected.last_error_code})}</p>}
      </DrawerBody>
      <DrawerFooter>
        {active&&<Button disabled={blocked(selected)} onClick={()=>void execute("refresh",{id:selected.id})}>{busy?copy.importing:t("updateNow")}</Button>}
        {active&&detail?.id!==selected.id&&<Button variant="outline" disabled={busy} onClick={()=>void execute("inspect",{id:selected.id})}>{t("viewAccounts")}</Button>}
        <Button variant={active?"outline":"default"} onClick={()=>{setCountry(selected.country);setFilter(selected.name);setChoice({name:selected.name,country:selected.country});setFlow(true);setSelected(null);}}>{t("reconnect")}</Button>
        {(selected.consent_state!=="revoked"||selected.revocation_confirmed===false)&&confirm!==selected.id&&<Button variant="ghost" className="text-neg" disabled={busy} onClick={()=>setConfirm(selected.id)}>{t("disconnect")}</Button>}
      </DrawerFooter></>}
    </DrawerContent></Drawer>
  </div>;
}
