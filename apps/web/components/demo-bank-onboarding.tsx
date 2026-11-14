"use client";
import {useEffect,useRef,useState} from "react";
import {ChartNoAxesColumn,MessageCircle,SlidersHorizontal,BookOpen} from "lucide-react";
import {Button} from "@/components/ui/button";
import {useCopy} from "@/i18n/context";
import {firstBankCopy} from "../i18n/first-bank";
import {matchesBank} from "../lib/bank-search";
import {BankPicker,preferredBankCountry} from "./first-bank";
import {nativeMoney} from "./import-files";

type Bank={id:string;name:string;country:string};
type Result={state:"consent"|"connected"|"cancelled"|"imported";name:string;token?:string;booked_transactions?:number;transactions?:{reference:string;merchant:string;amount_minor:number;booked_on:string}[]};
// This transport never accesses /api/v1, Auth0 cookies, live credentials or the
// private ledger. It rehearses the registered Python SyntheticBank adapters.
async function demo<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{const controller=new AbortController(),cancel=()=>controller.abort(),timer=setTimeout(cancel,10000);signal?.addEventListener("abort",cancel,{once:true});if(signal?.aborted)cancel();try{const response=await fetch(`/api/demo/${path}`,{method:body?"POST":"GET",cache:"no-store",signal:controller.signal,headers:{"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});if(!response.ok)throw new Error("DEMO_UNAVAILABLE");return await response.json() as T;}finally{clearTimeout(timer);signal?.removeEventListener("abort",cancel);}}
export function DemoBankOnboarding(){
 const {locale,t}=useCopy(),c=firstBankCopy[locale];
 const [banks,setBanks]=useState<Bank[]>([]),[bank,setBank]=useState<Bank|null>(null),[country,setCountry]=useState("EE"),[filter,setFilter]=useState("");
 const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(false),[result,setResult]=useState<Result|null>(null),[showRows,setShowRows]=useState(false),[revision,setRevision]=useState(0);
 const lock=useRef(false),epoch=useRef(0);
 useEffect(()=>{setCountry(preferredBankCountry());},[]);
 useEffect(()=>{const generation=++epoch.current,controller=new AbortController();setLoading(true);setError(false);void demo<Bank[]>("banks",undefined,controller.signal).then(items=>{if(generation===epoch.current)setBanks(items.map(item=>({...item,country:item.country??"EE"})));}).catch(()=>{if(generation===epoch.current)setError(true);}).finally(()=>{if(generation===epoch.current)setLoading(false);});return()=>{epoch.current++;controller.abort();};},[revision]);
 async function command(action:"select"|"approve"|"cancel"|"import",chosen=bank){if(!chosen||lock.current)return;lock.current=true;setBusy(true);setError(false);const generation=epoch.current;try{const next=await demo<Result>("banks/command",{action,institution:chosen.id,token:result?.token??null});if(generation===epoch.current){setBank(next.state==="cancelled"?null:chosen);setResult(next);}}catch{if(generation===epoch.current)setError(true);}finally{lock.current=false;setBusy(false);}}
 const filtered=banks.filter(item=>item.country===country&&matchesBank(item,filter));
 return <div className="mx-auto min-h-dvh max-w-app bg-canvas navigation-space"><header className="flex min-h-14 items-center px-4"><a href="/demo" className="text-xl font-semibold text-ink">Money Coach</a></header><main id="main" className="space-y-6 px-4 py-6" aria-busy={busy}>
  {bank&&result&&result.state!=="cancelled"?<section className="space-y-4"><p className="text-caption text-ink-2">{c.simulated}</p><h1 className="text-xl font-semibold">{result.state==="consent"?bank.name:c.connected.replace("{bank}",bank.name)}</h1>
  {result.state==="consent"?<><p className="text-sm text-ink-2">{c.consent}</p><Button className="w-full" disabled={busy} onClick={()=>void command("approve")}>{c.approve}</Button><Button variant="outline" className="w-full" disabled={busy} onClick={()=>void command("cancel")}>{c.cancel}</Button></>:result.state==="connected"?<Button className="w-full" disabled={busy} onClick={()=>void command("import")}>{busy?c.importing:c.import}</Button>:<><p role="status" className="text-sm">{result.booked_transactions?c.result.replace("{count}",String(result.booked_transactions)):c.none}</p><Button className="w-full" onClick={()=>setShowRows(true)}>{c.view}</Button>{showRows&&<ul aria-label={c.view} className="divide-y divide-line">{result.transactions?.map(row=><li key={row.reference} className="flex min-h-14 items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate text-sm">{row.merchant}</p><p className="text-caption text-ink-2">{row.booked_on}</p></div><span className="shrink-0 text-sm font-semibold">{nativeMoney(row.amount_minor,"EUR")}</span></li>)}</ul>}<p className="text-caption text-ink-2">{c.fixtureNote}</p></>}
  {error&&<div role="alert"><p>{c.failed}</p><Button variant="outline" disabled={busy} onClick={()=>{setBank(null);setResult(null);setRevision(v=>v+1);}}>{c.retry}</Button></div>}
  </section>:<>{result?.state==="cancelled"&&<p role="status" className="text-sm">{c.cancelled}</p>}<BankPicker simulated country={country} onCountry={setCountry} filter={filter} onFilter={setFilter} banks={filtered} loading={loading||busy} error={error?c.failed:""} retry={()=>setRevision(v=>v+1)} choose={chosen=>void command("select",chosen as Bank)}/></>}
  <Button asChild variant="outline" className="w-full"><a href="/demo?dataset=starter">{c.demo}</a></Button>
 </main><nav aria-label="Main navigation" className="pb-safe bottom-keyboard fixed inset-x-0 mx-auto grid min-h-navigation w-full max-w-app grid-cols-4 border-t border-line bg-surface px-2 py-1">{([{key:"overview",Icon:ChartNoAxesColumn},{key:"coach",Icon:MessageCircle},{key:"whatif",Icon:SlidersHorizontal},{key:"learn",Icon:BookOpen}] as const).map(({key,Icon})=><a className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-caption text-ink-2" key={key} href={`/demo?dataset=starter&tab=${key}`}><Icon className="size-6"/>{t(key)}</a>)}</nav></div>;
}
