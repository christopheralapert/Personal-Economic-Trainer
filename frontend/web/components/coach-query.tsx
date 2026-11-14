"use client";

import {useEffect,useRef,useState,type FormEvent} from "react";
import type {components} from "@contracts";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {ArrowUp} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useCopy} from "@/i18n/context";
import {coachCopy} from "../i18n/private-coach";
import {CoachEvidence,CoachRecord} from "./coach-evidence";
import {euros} from "./plan-format";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerTrigger} from "@/components/ui/drawer";
import {StatementDates} from "./statement-dates";

type Schema=components["schemas"];
type Answer=Schema["CoachAnswerV1"];
type Turn={id:number;question:string;answer?:Answer};

function ledgerEvidence(answer:Answer):Schema["LedgerScopeV1"]|null {
  if(answer.habits) return answer.habits.baseline.scope;
  const artifact=answer.card?.answer.artifact;
  if(artifact?.name==="spending_totals") return artifact.result.scope;
  if(artifact?.name==="spending_comparison") return artifact.result.current.scope;
  if(artifact?.name==="spending_reduction") return artifact.result.baseline.scope;
  return null;
}

const destinations:Record<string,{href:string;label:string}>={
  planning_read:{href:"/plan",label:"Open plan"},goal_list:{href:"/goals",label:"Open goals"},
  bank_connections:{href:"/banks",label:"Open bank connections"},insight_list:{href:"/insights",label:"Open insights"},
  population_reference:{href:"/compare",label:"Open comparison"},
};

export function CoachQuery({request,initialQuestion=""}:{request:PrivateRequest;initialQuestion?:string}) {
  const {locale,setLocale,privacy,setPrivacy}=useCopy(),c=coachCopy[locale];
  const [question,setQuestion]=useState(initialQuestion);
  const [accounts,setAccounts]=useState<Schema["AccountView"][]>([]),[account,setAccount]=useState("");
  const [scopeError,setScopeError]=useState(false),[importedPeriod,setImportedPeriod]=useState("");
  const [turns,setTurns]=useState<Turn[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [searchRows,setSearchRows]=useState<Schema["LedgerRowV1"][]>([]),[searchCursor,setSearchCursor]=useState<string|null>(null);
  const latest=useRef(0),nextId=useRef(0),activeTurn=useRef<number|null>(null),input=useRef<HTMLInputElement>(null);
  const conversationEnd=useRef<HTMLDivElement>(null);
  useEffect(()=>{input.current?.focus();},[]);
  useEffect(()=>{if(turns.length)conversationEnd.current?.scrollIntoView({block:"end",behavior:"instant"});},[turns,busy]);
  useEffect(()=>{let active=true;const query=new URL(window.location.href).searchParams;const selected=query.get("account_id");if(selected)setAccount(selected);const start=query.get("start"),end=query.get("end");if(start&&end)setImportedPeriod(`${start} — ${end}`);void request<Schema["AccountView"][]>("accounts").then(values=>{if(active)setAccounts(values.filter(value=>value.included&&value.currency==="EUR"));}).catch(reason=>{if(active&&!aborted(reason))setScopeError(true);});return()=>{active=false;};},[request]);
  useEffect(()=>{if(initialQuestion&&!turns.length)setQuestion(initialQuestion);},[initialQuestion,turns.length]);
  useEffect(()=>{
    const choose=(event:Event)=>{const value=(event as CustomEvent<string>).detail;if(typeof value==="string")setQuestion(value);};
    window.addEventListener("moneylens-coach-question",choose);return()=>window.removeEventListener("moneylens-coach-question",choose);
  },[]);

  function clearDraft(){latest.current++;setQuestion("");setError("");}
  async function ask(event?:FormEvent,raw=question) {
    event?.preventDefault();
    const text=raw.trim();if(busy||!text)return;
    const generation=++latest.current,id=++nextId.current,previous=turns.at(-1)?.answer;
    const previousScope=previous?.transactions?.scope??(previous?ledgerEvidence(previous):null);
    const accountIds=account?[account]:null;
    const previousIntent=previous?.interpretation.intent;
    const selected=previousIntent?.kind==="analysis"?previousIntent.tool:null;
    const selectors=previousIntent?.kind==="habits"?previousIntent.arguments:selected&&"start" in selected.arguments?selected.arguments:null;
    const reduction=selected?.name==="spending_reduction"&&selected.arguments.change.kind==="percentage"?selected.arguments.change.reduction_basis_points:null;
    const comparison=selected?.name==="spending_comparison"&&(selected.arguments.mode==="previous_month"||selected.arguments.mode==="previous_period")?selected.arguments.mode:null;
    const context=previousScope ? JSON.stringify({start:previousScope.start,end_exclusive:previousScope.end_exclusive,...(selected?{tool:selected.name}:previousIntent?.kind==="habits"?{tool:"habits"}:{}),...(selectors&&"category" in selectors?{category:selectors.category}:{}),...(selectors&&"merchant" in selectors?{merchant:selectors.merchant}:{}),...(reduction!==null?{reduction_basis_points:reduction}:{}),...(comparison?{comparison_mode:comparison}:{})}) : undefined;
    activeTurn.current=id;setTurns(items=>[...items,{id,question:text}]);setQuestion("");setBusy(true);setError("");setSearchRows([]);setSearchCursor(null);
    try {
      const history=privacy?[]:turns.flatMap(turn=>[{role:'user' as const,text:turn.question},...(turn.answer?.answer_text?[{role:'assistant' as const,text:turn.answer.answer_text}]:[])]).slice(-8).map(turn=>({...turn,text:turn.text.slice(0,2000)}));
      const answer=await request<Answer>("coach/query",{question:text,card_locale:locale,privacy,currency:"EUR",account_ids:accountIds,expected_data_version:null,conversation_context:context,conversation_history:history});
      if(generation!==latest.current)return;
      setTurns(items=>items.map(turn=>turn.id===id?{...turn,answer}:turn));
      setSearchRows(answer.transactions?.rows??[]);setSearchCursor(answer.transactions?.next_cursor??null);
    } catch(reason) {
      if(generation===latest.current&&!aborted(reason)) {
        const code=reason instanceof PrivateApiError?reason.code:"";
        setError(code.startsWith("MODEL_")&&reason instanceof PrivateApiError?reason.message:c.failed);
      }
    } finally {if(generation===latest.current)setBusy(false);}
  }

  async function nextSearch(){
    const turn=turns.at(-1),answer=turn?.answer;
    if(!answer?.transactions||!searchCursor||busy||answer.interpretation.intent?.kind!=="analysis")return;
    const intent=answer.interpretation.intent.tool;if(intent.name!=="ledger_transactions")return;
    const generation=latest.current;setBusy(true);setError("");
    try {
      const a=intent.arguments,q=new URLSearchParams({start:a.start,end_exclusive:a.end_exclusive,currency:a.currency??answer.transactions.scope.currency,status:"booked",spending_only:"false",limit:"50",cursor:searchCursor,expected_data_version:String(answer.transactions.scope.data_version)});
      if(a.category)q.set("category",a.category);if(a.merchant)q.set("merchant",a.merchant);
      for(const id of answer.transactions.scope.account_ids)q.append("account_id",id);
      const next=await request<Schema["LedgerPageV1"]>(`ledger/transactions?${q}`);
      if(generation===latest.current){setSearchRows(rows=>[...rows,...next.rows]);setSearchCursor(next.next_cursor);}
    } catch(reason){if(generation===latest.current&&!aborted(reason))setError("The record scope changed. Ask the question again.");}
    finally {if(generation===latest.current)setBusy(false);}
  }

  function answerView(answer:Answer,isLatest:boolean) {
    const card=answer.card,habits=answer.habits,evidence=ledgerEvidence(answer),destination=card?destinations[card.answer.artifact.name??""]:null;
    if(answer.transactions) {
      const rows=isLatest?searchRows:answer.transactions.rows;
      const historyQuery=new URLSearchParams({start:answer.transactions.scope.start,end:answer.transactions.scope.end_exclusive});
      if(answer.transactions.scope.account_ids.length===1)historyQuery.set("account_id",answer.transactions.scope.account_ids[0]);
      return <><h3 className="text-lg font-semibold">{c.matches}</h3><p data-coach-answer className="text-base leading-relaxed">{answer.answer_text}</p><p className="text-caption text-ink-2">{answer.transactions.scope.start} — {answer.transactions.scope.end_exclusive} · {rows.length} {c.shown}</p>
        <ul className="mt-3 divide-y divide-line">{rows.map(row=><li key={row.id} data-coach-ledger-row><CoachRecord row={row}/></li>)}</ul>
        {!rows.length&&<p className="py-4 text-sm text-ink-2">{c.noMatches}</p>}
        {isLatest&&searchCursor&&<button className="secondary-button mt-3" disabled={busy} onClick={()=>void nextSearch()}>{c.next}</button>}
        <a className="mt-3 inline-block text-sm text-brand underline" href={`/transactions?${historyQuery}`}>{c.history}</a><p className="mt-3 text-caption text-ink-2">{answer.source==="model"?c.model:c.rule} {answer.transactions.scope.dataset_coverage!=="covered_synthetic_snapshot"?c.partial:""}</p></>;
    }
    const artifact=card?.answer.artifact;
    const totals=artifact?.name==="spending_totals"?artifact.result:artifact?.name==="spending_comparison"?artifact.result.current:artifact?.name==="spending_reduction"?artifact.result.baseline:null;
    const mainFact=card?.rows.find(row=>/net|saving|reduction|gross/.test(row.fact_id));
    return <>
      {card?<div><h3 className="text-sm text-ink-2">{card.title}</h3>{card.answer.status==="ready"&&mainFact&&<p className="mt-1 text-3xl font-bold">{mainFact.value_text}</p>}<p data-coach-answer className="mt-2 whitespace-pre-wrap text-base leading-relaxed">{answer.answer_text || card.summary}</p>
        <Drawer><DrawerTrigger asChild><Button variant="ghost" size="chip" className="mt-3 text-ink-2">{c.basis}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{card.title}</DrawerTitle></DrawerHeader><div className="max-h-sheet overflow-y-auto px-4 pb-6"><p className="text-caption text-ink-2">{card.status_label}</p><dl className="mt-3 divide-y divide-line">{card.rows.map(row=><div key={row.fact_id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm"><dt>{row.label}</dt><dd className="font-semibold">{row.value_text}</dd></div>)}</dl><ul className="mt-3 space-y-2 text-caption text-ink-2">{card.notices.map((notice,index)=><li key={index}>{notice}</li>)}</ul></div></DrawerContent></Drawer>
      </div>:habits?<div><h3 className="text-lg font-semibold">{c.patterns}</h3><p data-coach-answer className="mt-2 whitespace-pre-wrap text-base leading-relaxed">{answer.answer_text}</p><ul className="mt-3 divide-y divide-line">{habits.category_patterns.map(pattern=><li key={pattern.label} className="flex justify-between gap-3 py-2 text-sm"><span>{pattern.label}</span><strong>{euros(pattern.gross_minor)}</strong></li>)}</ul></div>:<p data-coach-answer className="whitespace-pre-wrap text-base leading-relaxed">{answer.answer_text || answer.interpretation.message}</p>}
      {evidence&&<CoachEvidence request={request} scope={evidence} filters={totals?.evidence_filters}/>}
      {destination&&<a className="primary-button mt-4 inline-block" href={destination.href}>{destination.label}</a>}
      <p className="mt-3 text-caption text-ink-2">{answer.source==="model"?c.model:c.rule}</p>
      {answer.source==="model"&&<Drawer><DrawerTrigger asChild><Button variant="ghost" size="chip" className="mt-3">{c.saw}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.saw}</DrawerTitle></DrawerHeader><p className="px-4 pb-6 text-sm">{c.sawNote}</p></DrawerContent></Drawer>}
    </>;
  }

  function resetConversation(){latest.current++;setTurns([]);setSearchRows([]);setSearchCursor(null);setBusy(false);setError("");}
  return <section className="space-y-5 pb-24" aria-label="Coach conversation">
    <div className="space-y-3 border-b border-line pb-4"><div className="grid gap-3"><label className="grid gap-1 text-sm">{c.language}<select aria-label={c.language} className="min-h-12 rounded-xl border border-input bg-surface px-3 text-base" value={locale} onChange={event=>{resetConversation();setLocale(event.target.value as "en"|"fi"|"et");}}><option value="en">English</option><option value="fi">Suomi</option><option value="et">Eesti</option></select></label><label className="grid gap-1 text-sm">{c.account}<select aria-label={c.account} aria-describedby="coach-scope-note" className="min-h-12 w-full rounded-xl border border-input bg-surface px-3 text-base" value={account} disabled={scopeError} onChange={event=>{resetConversation();setAccount(event.target.value);setImportedPeriod("");}}><option value="">{c.all}</option>{accounts.map(value=><option key={value.id} value={value.id}>{value.name} · {value.currency}</option>)}</select></label></div><p id="coach-scope-note" className="text-caption text-ink-2">{c.change}</p>{scopeError&&<p role="alert" className="text-sm text-neg">{c.scopeError}</p>}{importedPeriod&&<p className="text-sm text-ink-2">{c.period}: {importedPeriod}</p>}<label className="flex min-h-12 items-center gap-3 text-sm"><input type="checkbox" checked={privacy} onChange={event=>{resetConversation();setPrivacy(event.target.checked);}}/>{c.privacy}</label><p className="text-caption text-ink-2">{privacy?c.privacyNote:c.onlineNote}</p></div>
    <StatementDates request={request} accountId={account}/>
    <div className="space-y-5" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
      {!turns.length&&<p className="text-sm text-ink-2">{c.empty}</p>}
      {turns.map((turn,index)=><article key={turn.id} className="space-y-3" data-coach-turn><div className="ml-8 rounded-bubble rounded-br-sm bg-brand p-4 text-brand-ink"><p className="wrap-anywhere text-sm">{turn.question}</p></div>{turn.answer&&<div className="message-arrival rounded-bubble rounded-bl-sm bg-surface p-4">{answerView(turn.answer,index===turns.length-1)}</div>}</article>)}
      {busy&&<div role="status" className="rounded-bubble bg-surface p-4 text-sm text-ink-2">{c.loading}</div>}
      <div ref={conversationEnd} className="scroll-mb-48"/>
    </div>
    {error&&<p className="error-notice" role="alert">{error}</p>}
    <form className="above-navigation fixed inset-x-0 z-30 mx-auto flex w-full max-w-app items-center gap-2 border-t border-line bg-surface px-4 py-3" onSubmit={event=>void ask(event)}>
      <label className="sr-only" htmlFor="coach-question">{c.question}</label>
      <Input ref={input} id="coach-question" aria-label={c.question} className="min-w-0 flex-1" maxLength={2000} autoComplete="off" placeholder={c.placeholder} value={question} disabled={busy} onChange={event=>{clearDraft();setQuestion(event.target.value);}}/>
      <Button size="icon" aria-label={c.ask} disabled={busy||!question.trim()}><ArrowUp className="size-5"/></Button>
    </form>
  </section>;
}
