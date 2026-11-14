"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import type {components} from "@contracts";
import {aborted, usePrivateSession, type PrivateRequest, type Session} from "./private-session";
import {PlanReviewForm} from "./plan-review-form";
import {SavedPlan, type PlanBundle} from "./saved-plan";
import {LiveBankWorkspace} from "./live-bank-workspace";
import {BankWorkspace} from "./bank-workspace";
import {PopulationWorkspace} from "./population-workspace";
import {GoalWorkspace} from "./goal-workspace";
import {CoachingWorkspace} from "./coaching-workspace";
import {AnalysisWorkspace} from "./analysis-workspace";
import {EducationHelp} from "./education-help";
import {SettingsWorkspace} from "./dashboard-workspace";
import {CoachWorkspace,TransactionWorkspace,ScenarioWorkspace} from "./money-tools";
import {PrivateOverview} from "./private-overview";
import {ChartNoAxesColumn,MessageCircle,SlidersHorizontal,BookOpen,Settings,ChevronLeft} from "lucide-react";
import {Button} from "@/components/ui/button";
import {PrivateLearn} from "./private-learn";
import {useKeyboardViewport} from "@/lib/use-keyboard-viewport";
import {useCopy} from "@/i18n/context";
import {ImportWorkspace} from "./import-workspace";
import {StatementImport} from "./statement-import";
import {DemoEntry} from "./demo-entry";
import {SettingsGroup,SettingsSheetRow} from "@/components/settings-list";

type Schema = components["schemas"];

function PlanningWorkspace({session, request, changed}: {session: Session; request: PrivateRequest; changed: () => void}) {
  const [context, setContext] = useState<Schema["ReviewContextV1"] | null>(null);
  const [bundle, setBundle] = useState<PlanBundle | null>(null);
  const [view, setView] = useState<"plan" | "review">("plan");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const latest = useRef(0);
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    const version = ++latest.current;
    setBusy(true); setError(""); setBundle(null); setContext(null);
    try {
      const [contextResult, planResult] = await Promise.allSettled([request<Schema["ReviewContextV1"]>("planning/context"), request<Schema["PlanViewV1"] | null>("plans/current")]);
      if (planResult.status === "rejected") throw planResult.reason;
      const plan = planResult.value;
      if (contextResult.status === "rejected" && !plan) throw contextResult.reason;
      const nextContext = contextResult.status === "fulfilled" ? contextResult.value : null;
      let loaded: PlanBundle | null = null;
      let reviewUnavailable = false;
      if (plan) {
        const [reviewResult, historyResult] = await Promise.allSettled([request<Schema["SavedPlanReviewV1"]>(`plans/${plan.id}/review`), request<Schema["AllocationPageV1"]>(`plans/${plan.id}/allocations`)]);
        if (historyResult.status === "rejected") throw historyResult.reason;
        const review = reviewResult.status === "fulfilled" ? reviewResult.value : null;
        const history = historyResult.value;
        reviewUnavailable = review === null;
        if ((review && review.inputs.plan_version !== plan.plan_version) || (plan.current && (history.plan_version !== plan.plan_version || history.data_version !== plan.data_version)))
          throw new Error("The plan changed while loading. Refresh it before making a choice.");
        loaded = {plan, review, history};
      }
      if (version !== latest.current) return;
      setContext(nextContext); setBundle(loaded); setRevision(value => value+1); setView(loaded ? "plan" : "review");
      if (contextResult.status === "rejected" || reviewUnavailable) setError("Source review is unavailable. You can still inspect and release saved reservations. Reload source details before making a new savings choice.");
    } catch (reason) { if (!aborted(reason) && version === latest.current) setError((reason as Error).message); }
    finally { if (version === latest.current) setBusy(false); }
  }, [request]);

  useEffect(() => { void load(); return () => { latest.current += 1; }; }, [load]);

  return <>
    <div className="page-heading"><div><h1>A plan you can account for.</h1><p>Review the money you can use, protect upcoming costs, then choose what to set aside.</p></div></div>
    <p className="demo-notice"><span className="demo-dot"/><span>{session.synthetic ? "Signed-in synthetic profile" : "Verified profile"} · {session.display_name}. Source times use the actual stored snapshots.</span></p>
    {busy && <p className="loading-state" role="status">Loading your owned planning information…</p>}
    {error && <div className="error-notice" role="alert"><span>{error}</span><button onClick={() => void load()}>Reload planning information</button></div>}
    {!busy && (context || bundle) && <>
      {view === "plan" && bundle ? <SavedPlan key={`${bundle.plan.id}:${bundle.plan.plan_version}:${revision}`} bundle={bundle} context={context} request={request} refresh={load} changed={changed} edit={() => setView("review")}/> : <>
        {bundle && <button className="text-button" onClick={() => setView("plan")}>Back to saved plan and reservations</button>}
        {context && <PlanReviewForm key={revision} context={context} request={request} saved={async () => {changed(); await load();}} refresh={() => void load()}/>}
      </>}
    </>}
  </>;
}

export type PrivatePageName="dashboard"|"plan"|"banks"|"compare"|"goals"|"insights"|"analysis"|"coach"|"transactions"|"scenarios"|"settings"|"learn"|"imports";

export function PrivatePlan({page = "plan",oidcAvailable=false,demoAvailable=false}: {oidcAvailable?:boolean;demoAvailable?:boolean;page?: PrivatePageName}) {
  const access = usePrivateSession();
  useEffect(()=>{if(page==='imports'&&access.phase==='signed-out'&&oidcAvailable)window.location.replace('/api/v1/auth/login?return_to=%2Fimport');},[page,access.phase,oidcAvailable]);
  useKeyboardViewport(page==="coach"&&access.phase==="ready");
  const {t}=useCopy();
  const privateKey=access.session ? `${access.session.session_id}:${access.session.permission_version}:${access.session.owner.tenant_id}:${access.session.owner.user_id}:${access.session.synthetic}` : "signed-out";
  const primary=[{key:"dashboard",href:"/",label:t("overview"),Icon:ChartNoAxesColumn},{key:"coach",href:"/coach",label:t("coach"),Icon:MessageCircle},{key:"scenarios",href:"/scenarios",label:t("whatif"),Icon:SlidersHorizontal},{key:"learn",href:"/learn",label:t("learn"),Icon:BookOpen}];
  return <div className="private-coach-shell mx-auto min-h-dvh w-full max-w-app bg-canvas navigation-space">
    <header className="pt-safe"><div className="flex min-h-touch items-center justify-between gap-3 px-4"><div className="min-w-0"><a className="text-xl font-semibold text-ink no-underline" href="/">Money Coach</a></div><Button asChild variant="ghost" size="icon"><a href={page==="settings"?"/":"/settings"} aria-label={page==="settings"?t("back"):t("settings")}>{page==="settings"?<ChevronLeft className="size-5"/>:<Settings className="size-5"/>}</a></Button></div></header>
    <main id="main" tabIndex={-1} className={page==="dashboard"?"px-4":"space-y-6 px-4 py-6"} aria-busy={access.phase==="checking"}>
        {access.error && <p className="error-notice" role="alert">{access.error}</p>}
        {access.phase === "ready" && access.session ? page === "imports" ? <StatementImport key={privateKey} request={access.request} changed={access.announce}/> : page === "settings" ? <SettingsWorkspace key={privateKey} request={access.request} changed={access.announce} signOut={()=>void access.signOut()}/> : page === "coach" ? <CoachWorkspace key={privateKey} request={access.request}/> : page === "transactions" ? <TransactionWorkspace key={privateKey} request={access.request}/> : page === "scenarios" ? <ScenarioWorkspace key={privateKey} request={access.request}/> : page === "dashboard" ? <PrivateOverview key={privateKey} request={access.request}/> : page === "learn" ? <PrivateLearn key={privateKey} request={access.request}/> : page === "analysis" ? <AnalysisWorkspace key={privateKey} request={access.request} synthetic={access.session.synthetic}/> : page === "banks" ? access.session.synthetic ? <><StatementImport key={`statement:${privateKey}`} request={access.request} changed={access.announce}/><p className="demo-notice"><strong>DEMO</strong> Synthetic bank accounts. Real-bank connections require a verified profile.</p><BankWorkspace key={privateKey} request={access.request} transfer={access.transfer} changed={access.announce}/></> : <><LiveBankWorkspace key={privateKey} request={access.request} changed={access.announce}><RetainedImports key={privateKey} request={access.request} transfer={access.transfer} changed={access.announce}/></LiveBankWorkspace><StatementImport key={`statement:${privateKey}`} request={access.request} changed={access.announce}/></> : page === "compare" ? <PopulationWorkspace key={privateKey} request={access.request}/> : page === "goals" ? <GoalWorkspace key={privateKey} request={access.request} changed={access.announce}/> : page === "insights" ? <CoachingWorkspace key={privateKey} request={access.request} changed={access.announce}/> : <PlanningWorkspace key={privateKey} session={access.session} request={access.request} changed={access.announce}/> :
          <section className="private-sign-in space-y-4 py-6">{access.phase==='checking'?<p role="status">Checking your session…</p>:access.phase==='offline'?<><p>You are offline. Reconnect to open your private workspace.</p><Button onClick={()=>void access.refresh()}>Check connection</Button></>:access.phase==='paused'?<Button onClick={()=>void access.refresh()}>Verify session</Button>:<DemoEntry embedded/>}</section>}
        {!["dashboard","transactions","learn","coach","scenarios","banks","settings","imports"].includes(page) && access.phase==="ready" && access.session && <EducationHelp key={`${privateKey}:${page}`} request={access.request}
          initialTopic={{learn:"spending_baskets",coach:"observed_spending",transactions:"observed_spending",scenarios:"scenario_assumptions",settings:"cash_flow",dashboard:"cash_flow",plan:"shared_surplus",banks:"cash_flow",compare:"population_mean",goals:"protected_money",insights:"scenario_assumptions",analysis:"observed_spending",imports:"observed_spending"}[page]}/>}
    </main>
    <nav aria-label="Main navigation" className="pb-safe bottom-keyboard fixed inset-x-0 z-40 mx-auto grid min-h-navigation w-full max-w-app grid-cols-4 border-t border-line bg-surface px-2 py-1">{primary.map(({key,href,label,Icon})=><a key={key} href={href} aria-current={key===page?"page":undefined} className={`flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-caption no-underline ${page===key?"bg-brand-tint text-active-ink":"text-ink-2"}`}><Icon className="size-6"/><span>{label}</span></a>)}</nav>
  </div>;
}

/** Saved statement files open in one sheet instead of an inline disclosure. */
function RetainedImports(props:React.ComponentProps<typeof ImportWorkspace>){const {t}=useCopy();return <SettingsGroup title={t("yourDataFiles")}><SettingsSheetRow label={t("yourDataFiles")}><ImportWorkspace {...props}/></SettingsSheetRow></SettingsGroup>;}
