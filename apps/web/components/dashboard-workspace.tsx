"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useCopy,type Locale} from "@/i18n/context";
import {RadioGroup,RadioGroupItem} from "@/components/ui/radio-group";
import type {components} from "@contracts";
import {aborted,type PrivateRequest} from "./private-session";

type Dashboard=components["schemas"]["DashboardView"];
const accountLabel=(id:string)=>`Bank ···${id.slice(-4)}`;
export function useDashboard(request:PrivateRequest){
  const [data,setData]=useState<Dashboard|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const epoch=useRef(0);
  const load=useCallback(async()=>{const version=++epoch.current;setLoading(true);setData(null);setError("");try{const next=await request<Dashboard>("dashboard");if(version===epoch.current)setData(next);}catch(e){if(version===epoch.current&&!aborted(e))setError("Your records could not be loaded. Check your connection and retry.");}finally{if(version===epoch.current)setLoading(false);}},[request]);
  useEffect(()=>{void load();return()=>{epoch.current++;};},[load]);
  useEffect(()=>{const changed=()=>void load();window.addEventListener("moneylens-data-changed",changed);return()=>window.removeEventListener("moneylens-data-changed",changed);},[load]);
  return {data,error,loading,load,setData,setError};
}
export function SettingsWorkspace({request,changed}:{request:PrivateRequest;changed:()=>void}){
  const {locale,setLocale,t}=useCopy();
  const {data,error,loading,load,setData,setError}=useDashboard(request);const [busy,setBusy]=useState(false);const lock=useRef(false);
  const toggle=async(id:string,included:boolean)=>{if(!data||lock.current)return;lock.current=true;setBusy(true);setError("");try{const next=await request<Dashboard>(`accounts/${id}/inclusion`,{included,expected_data_version:data.data_version});setData(next);changed();}catch(e){if(!aborted(e))setError("The selection could not be confirmed. Reload your data controls before retrying.");}finally{lock.current=false;setBusy(false);}};
  return <><div className="page-heading"><div><h1>Your data. Your control.</h1><p>Review which accounts enter analysis, and how your profile is protected.</p></div></div>
    <section className="space-y-3"><h2>{t("language")}</h2><RadioGroup aria-label={t("language")} value={locale} onValueChange={value=>setLocale(value as Locale)}>{(["en","fi","et"] as const).map((value,i)=><label key={value} className="flex min-h-14 items-center gap-3 border-b border-line"><RadioGroupItem value={value}/>{t((["english","finnish","estonian"] as const)[i])}</label>)}</RadioGroup></section>
    {loading&&<p role="status">Loading your data controls...</p>}{error&&<div role="alert" className="error-notice"><span>{error}</span><button onClick={()=>void load()}>Reload controls</button></div>}
    {data&&<><section className="panel bank-section"><h2>What the coach can see</h2><p>Only your owned, consented and included account records enter default analysis. This selection never authorizes a bank or transfers money.</p>{data.accounts.length===0?<p className="bank-empty">No imported accounts. Your financial history is empty.</p>:data.accounts.map(a=><label className="account-choice" key={a.id}><input type="checkbox" checked={a.included} disabled={busy} onChange={e=>void toggle(a.id,e.target.checked)}/><span>{a.name||accountLabel(a.id)}<small>{a.currency} / {a.source?.mode??"Source not verified"}</small></span></label>)}</section>
      <section className="panel bank-section"><h2>Security and consent</h2><dl className="plan-breakdown"><div><dt>Profile</dt><dd>{data.synthetic?"Synthetic demonstration":"Verified private membership"}</dd></div><div><dt>Live Banking</dt><dd>{data.live_banking_enabled?"Enabled for explicit consent":"Disabled"}</dd></div><div><dt>Hosted AI policy</dt><dd>{data.model_policy==="free_only"?"Outbound model calls blocked":"Separately configured"}</dd></div></dl><label className="account-choice"><input type="checkbox" checked={data.allow_ai_payment_descriptions} disabled={busy} onChange={async event=>{setBusy(true);try{const next=await request<Dashboard>("settings/ai-payment-descriptions",{enabled:event.target.checked});setData(next);}catch(e){if(!aborted(e))setError("The AI privacy setting could not be saved.");}finally{setBusy(false);}}}/><span>Let AI read payment descriptions<small>Off by default. Names and descriptions stay redacted unless enabled.</small></span></label><p>Sessions use server-side ownership checks. Private data stays out of the offline cache. Disconnecting a bank blocks its source access; retained history requires a separate reviewed deletion process.</p><div className="plan-actions"><a href="/banks">Manage bank consent</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div></section></>}
  </>;
}
