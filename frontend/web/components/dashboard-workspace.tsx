"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {useCopy,type Locale} from "@/i18n/context";
import {RadioGroup,RadioGroupItem} from "@/components/ui/radio-group";
import {ChevronRight} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Skeleton} from "@/components/ui/skeleton";
import {InlineError} from "@/components/ui/inline-error";
import {SettingsGroup,SettingsRow,SettingsSheetRow} from "@/components/settings-list";
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
const tools:[string,"toolTransactions"|"toolPlan"|"toolGoals"|"toolAnalysis"|"toolCompare"|"toolInsights"][]=[["/transactions","toolTransactions"],["/plan","toolPlan"],["/goals","toolGoals"],["/analysis","toolAnalysis"],["/compare","toolCompare"],["/insights","toolInsights"]];
/** Private settings: grouped rows, plain language, detail in one sheet, legal links only here. */
export function SettingsWorkspace({request,changed,signOut}:{request:PrivateRequest;changed:()=>void;signOut?:()=>void}){
  const {locale,setLocale,t}=useCopy();
  const {data,error,loading,load,setData,setError}=useDashboard(request);const [busy,setBusy]=useState(false);const lock=useRef(false);
  const toggle=async(id:string,included:boolean)=>{if(!data||lock.current)return;lock.current=true;setBusy(true);setError("");try{const next=await request<Dashboard>(`accounts/${id}/inclusion`,{included,expected_data_version:data.data_version});setData(next);changed();}catch(e){if(!aborted(e))setError(t("settingsSaveError"));}finally{lock.current=false;setBusy(false);}};
  const describe=async(enabled:boolean)=>{setBusy(true);try{const next=await request<Dashboard>("settings/ai-payment-descriptions",{enabled});setData(next);}catch(e){if(!aborted(e))setError(t("settingsSaveError"));}finally{setBusy(false);}};
  const check="size-5 shrink-0 accent-brand";
  return <div className="space-y-6"><h1 className="text-xl font-semibold">{t("settings")}</h1>
    <SettingsGroup title={t("language")}><RadioGroup aria-label={t("language")} value={locale} onValueChange={value=>setLocale(value as Locale)} className="gap-0 divide-y divide-line">{(["en","fi","et"] as const).map((value,i)=><label key={value} className="flex min-h-14 items-center gap-3 px-4"><RadioGroupItem value={value}/>{t((["english","finnish","estonian"] as const)[i])}</label>)}</RadioGroup></SettingsGroup>
    {loading&&<div role="status" className="space-y-3"><span className="sr-only">{t("reading")}</span><Skeleton className="h-28 w-full rounded-2xl"/><Skeleton className="h-28 w-full rounded-2xl"/></div>}
    {error&&<InlineError message={error||t("settingsLoadError")} onRetry={()=>void load()}/>}
    {data&&<>
      <SettingsGroup title={t("settingsDataSource")}><SettingsRow label={t("profileRow")} value={t(data.synthetic?"profileDemo":"profileVerified")}/><SettingsRow label={t("tryDemo")} href="/demo?dataset=organizer1"/></SettingsGroup>
      <SettingsGroup title={t("coachVisibility")} note={t("coachSeesNote")}>{data.accounts.length===0?<p className="px-4 py-4 text-sm text-ink-2">{t("noAccountsYet")}</p>:data.accounts.map(a=><label key={a.id} className="flex min-h-14 items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1"><span className="block text-base">{accountLabel(a.id)}</span><span className="block text-caption text-ink-2">{[a.name,a.currency].filter(Boolean).join(" · ")}</span></span><input type="checkbox" className={check} checked={a.included} disabled={busy} onChange={e=>void toggle(a.id,e.target.checked)}/></label>)}</SettingsGroup>
      <SettingsGroup title={t("settingsAiPrivacy")}><SettingsRow label={t("onlineAi")} value={t(data.model_policy==="free_only"?"hostedAiOff":"hostedAiOn")}/><label className="flex min-h-14 items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1"><span className="block text-base">{t("aiReadDescriptions")}</span><span className="block text-caption text-ink-2">{t("aiReadDescriptionsNote")}</span></span><input type="checkbox" className={check} checked={data.allow_ai_payment_descriptions} disabled={busy} onChange={event=>void describe(event.target.checked)}/></label></SettingsGroup>
      <SettingsGroup title={t("settingsBanks")}><SettingsRow label={t("bankConnections")} value={t(data.live_banking_enabled?"bankConnectionsOn":"bankConnectionsOff")} href="/banks"/></SettingsGroup>
      <SettingsGroup title={t("moreTools")}><SettingsSheetRow label={t("moreTools")} value={t("moreToolsNote")}><ul className="divide-y divide-line">{tools.map(([href,key])=><li key={href}><a className="flex min-h-14 items-center justify-between gap-3 py-3 text-ink no-underline" href={href}>{t(key)}<ChevronRight className="size-4 text-ink-2" aria-hidden="true"/></a></li>)}</ul></SettingsSheetRow></SettingsGroup>
    </>}
    <SettingsGroup title={t("settingsAbout")} note={t("disclaimer")}><SettingsRow label={t("privacyPolicy")} href="/privacy"/><SettingsRow label={t("termsOfUse")} href="/terms"/></SettingsGroup>
    {signOut&&<Button variant="outline" className="w-full" onClick={signOut}>{t("signOut")}</Button>}
  </div>;
}
