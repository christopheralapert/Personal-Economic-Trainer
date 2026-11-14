"use client";

import {useEffect,useRef,useState,type FormEvent} from "react";
import type {components} from "@contracts";
import {aborted,PrivateApiError,type PrivateRequest} from "./private-session";
import {ArrowUp} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {CategoryIcon} from "@/components/gen/category-icon";
import {euros,planDate} from "./plan-format";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerTrigger} from "@/components/ui/drawer";

type Schema=components["schemas"];
type Answer=Schema["CoachAnswerV1"];
type Locale="en"|"fi"|"sv";
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
  const [question,setQuestion]=useState(initialQuestion),[locale,setLocale]=useState<Locale>("en");
  const [turns,setTurns]=useState<Turn[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [searchRows,setSearchRows]=useState<Schema["LedgerRowV1"][]>([]),[searchCursor,setSearchCursor]=useState<string|null>(null);
  const latest=useRef(0),nextId=useRef(0),activeTurn=useRef<number|null>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{input.current?.focus();},[]);
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
    const accountIds=previousScope?.account_ids??null;
    const previousIntent=previous?.interpretation.intent;
    const selected=previousIntent?.kind==="analysis"?previousIntent.tool:null;
    const selectors=selected&&"start" in selected.arguments?selected.arguments:null;
    const context=previousScope ? JSON.stringify({start:previousScope.start,end_exclusive:previousScope.end_exclusive,...(selected?{tool:selected.name}:{}),...(selectors&&"category" in selectors?{category:selectors.category}:{}),...(selectors&&"merchant" in selectors?{merchant:selectors.merchant}:{}),...(selectors&&"reduction_basis_points" in selectors?{reduction_basis_points:selectors.reduction_basis_points}:{})}) : undefined;
    activeTurn.current=id;setTurns(items=>[...items,{id,question:text}]);setQuestion("");setBusy(true);setError("");setSearchRows([]);setSearchCursor(null);
    try {
      const answer=await request<Answer>("coach/query",{question:text,card_locale:locale,currency:"EUR",account_ids:accountIds,expected_data_version:null,conversation_context:context});
      if(generation!==latest.current)return;
      setTurns(items=>items.map(turn=>turn.id===id?{...turn,answer}:turn));
      setSearchRows(answer.transactions?.rows??[]);setSearchCursor(answer.transactions?.next_cursor??null);
    } catch(reason) {
      if(generation===latest.current&&!aborted(reason)) {
        const code=reason instanceof PrivateApiError?reason.code:"";
        setError(code.startsWith("MODEL_")&&reason instanceof PrivateApiError?reason.message:"The question needs another look. Try a period such as last month.");
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
      return <><h3 className="text-lg font-semibold">Matching records</h3><p className="text-caption text-ink-2">{answer.transactions.scope.start} — {answer.transactions.scope.end_exclusive} · {rows.length} shown</p>
        <ul className="mt-3 divide-y divide-line">{rows.map(row=><li key={row.id} data-coach-ledger-row className="flex min-h-14 items-center justify-between gap-3 py-2"><CategoryIcon category={row.category}/><span className="min-w-0 flex-1"><strong className="block wrap-anywhere text-sm">{row.merchant}</strong><small className="block text-caption text-ink-2">{row.booked_on} · {row.category} · {row.economic_flow}</small></span><strong className="shrink-0">{euros(row.amount_minor)}</strong></li>)}</ul>
        {!rows.length&&<p className="py-4 text-sm text-ink-2">No matching booked records. Missing history does not prove zero.</p>}
        {isLatest&&searchCursor&&<button className="secondary-button mt-3" disabled={busy} onClick={()=>void nextSearch()}>Load next entries</button>}
        <a className="mt-3 inline-block text-sm text-brand underline" href={`/transactions?${historyQuery}`}>{answer.transactions.scope.account_ids.length===1?"Open account history":"Open history (all included accounts)"}</a><p className="mt-3 text-caption text-ink-2">{answer.interpretation.method==="structured_model"?"AI model; records from authorized server tools.":"Local rules; records from authorized server tools."} {answer.transactions.scope.dataset_coverage!=="covered_synthetic_snapshot"?"History may be incomplete.":""}</p></>;
    }
    return <>{card?<div><h3 className="text-sm text-ink-2">{card.title}</h3>{card.answer.status==="ready"&&card.rows.find(row=>/net|saving|reduction|gross/.test(row.fact_id))&&<p className="mt-1 text-3xl font-bold">{card.rows.find(row=>/net|saving|reduction|gross/.test(row.fact_id))!.value_text}</p>}<p className="mt-2 text-sm leading-relaxed">{card.summary}</p><Drawer><DrawerTrigger asChild><Button variant="ghost" size="chip" className="mt-3 text-ink-2">{evidence?`${evidence.start} — ${evidence.end_exclusive}`:"Basis"} · Details</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{card.title}</DrawerTitle></DrawerHeader><div className="max-h-sheet overflow-y-auto px-4 pb-6"><p className="text-caption text-ink-2">{card.status_label}</p><dl className="mt-3 divide-y divide-line">{card.rows.map(row=><div key={row.fact_id} className="flex min-h-12 items-center justify-between gap-3 py-2 text-sm"><dt>{row.label}</dt><dd className="font-semibold">{row.value_text}</dd></div>)}</dl><ul className="mt-3 space-y-2 text-caption text-ink-2">{card.notices.map((notice,index)=><li key={index}>{notice}</li>)}</ul></div></DrawerContent></Drawer></div>:habits?<div><h3 className="text-lg font-semibold">Observed patterns</h3><ul className="mt-3 divide-y divide-line">{habits.category_patterns.map(pattern=><li key={pattern.label} className="flex justify-between gap-3 py-2 text-sm"><span>{pattern.label}</span><strong>{euros(pattern.gross_minor)}</strong></li>)}</ul></div>:<p className="text-sm">{answer.interpretation.message}</p>}{destination&&<a className="primary-button mt-4 inline-block" href={destination.href}>{destination.label}</a>}<p className="mt-3 text-caption text-ink-2">{answer.interpretation.method==="structured_model"?"AI model; calculations and records from authorized server tools.":"Local rules."}</p>{answer.interpretation.method==="structured_model"&&<Drawer><DrawerTrigger asChild><button className="mt-3 text-caption text-brand underline">AI</button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>What the AI saw</DrawerTitle></DrawerHeader><div className="space-y-2 px-4 pb-6 text-sm"><p>The model saw only your question and validated selectors.</p>{evidence&&<p>Server scope: {evidence.start} — {evidence.end_exclusive}, {evidence.account_ids.length} account(s).</p>}    <p>Amounts and records came from authorised server tools, not from the model.</p><p>Payment descriptions: {answer.allow_ai_payment_descriptions?"enabled":"redacted"}.</p></div></DrawerContent></Drawer>}</>;
  }

  return <section className="space-y-5" aria-label="Coach conversation">
    <div className="space-y-5" aria-live="polite" aria-relevant="additions" aria-busy={busy}>
      {!turns.length&&<p className="text-sm text-ink-2">Ask about your records.</p>}
      {turns.map((turn,index)=><article key={turn.id} className="space-y-3" data-coach-turn><div className="ml-8 rounded-bubble rounded-br-sm bg-brand p-4 text-brand-ink"><p className="wrap-anywhere text-sm">{turn.question}</p></div>{turn.answer&&<div className="message-arrival rounded-bubble rounded-bl-sm bg-surface p-4">{answerView(turn.answer,index===turns.length-1)}</div>}</article>)}
      {busy&&<div role="status" className="rounded-bubble bg-surface p-4 text-sm text-ink-2">Reading your authorized records…</div>}
    </div>
    {error&&<p className="error-notice" role="alert">{error}</p>}
    <form className="above-navigation fixed inset-x-0 z-30 mx-auto flex w-full max-w-app items-center gap-2 border-t border-line bg-surface px-4 py-3" onSubmit={event=>void ask(event)}>
      <label className="sr-only" htmlFor="coach-question">Question (English)</label>
      <Input ref={input} id="coach-question" aria-label="Question (English)" className="min-w-0 flex-1" maxLength={2000} autoComplete="off" placeholder="Ask about your records…" value={question} disabled={busy} onChange={event=>{clearDraft();setQuestion(event.target.value);}}/>
      <Button size="icon" aria-label="Read my records" disabled={busy||!question.trim()}><ArrowUp className="size-5"/></Button>
      <select className="sr-only" aria-label="Answer card language" value={locale} onChange={event=>{setLocale(event.target.value as Locale);latest.current++;}}><option value="en">English</option><option value="fi">Suomi</option><option value="sv">Svenska</option></select>
    </form>
  </section>;
}
