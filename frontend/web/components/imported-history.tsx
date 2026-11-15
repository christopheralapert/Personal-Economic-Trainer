"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {useEffect,useRef,useState,type FormEvent} from "react";
import type {components} from "@contracts";
import {useCopy,categoryLabel} from "@/i18n/context";
import {recordsCopy} from "../i18n/private-records";
import {aborted,type PrivateRequest} from "./private-session";
import {useDashboard} from "./dashboard-workspace";
import {date} from "@/lib/format";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {CategoryIcon} from "@/components/gen/category-icon";
import {SlidersHorizontal,Info} from "lucide-react";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerFooter,DrawerClose} from "@/components/ui/drawer";
import {euros} from "./plan-format";
import {ClassificationSheet} from "./classification-sheet";
import {reviewCopy} from "../i18n/classification-review";
import {StatementDates} from "./statement-dates";

type Schema=components["schemas"];
type Period={start:string;end_exclusive:string};
const recent=()=>{const today=new Date();return {start:new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth()-1,1)).toISOString().slice(0,10),end_exclusive:new Date(Date.UTC(today.getUTCFullYear(),today.getUTCMonth(),1)).toISOString().slice(0,10)};};
export function ImportedHistory({request}:{request:PrivateRequest}){
 const {locale,t}=useCopy(),c=recordsCopy[copyLocale(locale)],r=reviewCopy[copyLocale(locale)],{data}=useDashboard(request);
 const [dates,setDates]=useState<Period>(recent),[account,setAccount]=useState(""),[merchant,setMerchant]=useState("");
 const [inventory,setInventory]=useState<Schema["LedgerInventoryV1"]|null>(null),[page,setPage]=useState<Schema["LedgerPageV1"]|null>(null);
 const [filtersOpen,setFiltersOpen]=useState(false);
 const [needsReview,setNeedsReview]=useState(false),[selected,setSelected]=useState<Schema["LedgerRowV1"]|null>(null),[notice,setNotice]=useState("");
 const [busy,setBusy]=useState(true),[error,setError]=useState("");const epoch=useRef(0);
 function change(action:()=>void){epoch.current++;setPage(null);setInventory(null);setBusy(false);setError("");setSelected(null);setNotice("");action();}
 async function read(period:Period,selected:string,text:string,cursor:string|null=null,all=false,review=needsReview){
  const generation=++epoch.current;setBusy(true);setError("");
  try{
   let metadata=inventory,scope=period;
   const query=new URLSearchParams({...period,currency:"EUR",status:"booked",spending_only:"false",limit:"50"});
   if(selected)query.append("account_id",selected);
   if(!cursor){
    const metaQuery=new URLSearchParams({...period,currency:"EUR"});if(selected)metaQuery.append("account_id",selected);
    metadata=await request<Schema["LedgerInventoryV1"]>(`ledger/inventory?${metaQuery}`);
    if(generation!==epoch.current)return;
    setInventory(metadata);
    if(all&&metadata.available_start&&metadata.available_end_exclusive){scope={start:metadata.available_start,end_exclusive:metadata.available_end_exclusive};setDates(scope);
     metadata=await request<Schema["LedgerInventoryV1"]>(`ledger/inventory?${new URLSearchParams({...scope,currency:"EUR",...(selected?{account_id:selected}:{})})}`);
     if(generation!==epoch.current)return;setInventory(metadata);}
    query.set("start",scope.start);query.set("end_exclusive",scope.end_exclusive);
   }
   if(review)query.set("needs_review","true");
   if(text)query.set("merchant",text);
   if(cursor)query.set("cursor",cursor);
   const version=cursor?page?.scope.data_version:metadata?.scope.data_version;
   if(version!==undefined)query.set("expected_data_version",String(version));
   const next=await request<Schema["LedgerPageV1"]>(`ledger/transactions?${query}`);
   if(generation!==epoch.current)return;
   setPage(previous=>cursor&&previous?{...next,rows:[...previous.rows,...next.rows]}:next);
  }catch(reason){if(generation===epoch.current&&!aborted(reason)){setPage(null);setError(c.failed);}}
  finally{if(generation===epoch.current)setBusy(false);}
 }
 useEffect(()=>{
  const url=new URL(window.location.href),start=url.searchParams.get("start"),end=url.searchParams.get("end")??url.searchParams.get("end_exclusive"),selected=url.searchParams.get("account_id")??"";
  const explicit=Boolean(start&&end&&/^\d{4}-\d{2}-\d{2}$/.test(start)&&/^\d{4}-\d{2}-\d{2}$/.test(end));
  const period=explicit?{start:start!,end_exclusive:end!}:recent();setDates(period);setAccount(selected);
  const review=url.searchParams.get("needs_review")==="true";setNeedsReview(review);void read(period,selected,"",null,!explicit,review);return()=>{epoch.current++;};
  // request is stable for the currently verified identity; remount clears scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[request]);
 const datesValid=Boolean(dates.start&&dates.end_exclusive&&!Number.isNaN(Date.parse(dates.start))&&!Number.isNaN(Date.parse(dates.end_exclusive)));
 return <div className="space-y-5"><div className="flex items-center justify-between gap-3"><h1 className="text-xl font-bold">{c.title}</h1><Drawer open={filtersOpen} onOpenChange={setFiltersOpen}><DrawerTrigger asChild><Button variant="outline" size="chip"><SlidersHorizontal className="size-4"/>{c.filters}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.filters}</DrawerTitle></DrawerHeader><form className="space-y-4 px-4" onSubmit={(event:FormEvent)=>{event.preventDefault();setFiltersOpen(false);void read(dates,account,merchant);}}><div className="grid grid-cols-2 gap-3"><label className="space-y-1 text-sm">{c.fromDate}<Input type="date" required value={dates.start} onChange={e=>change(()=>setDates({...dates,start:e.target.value}))}/></label><label className="space-y-1 text-sm">{c.untilDate}<Input type="date" required value={dates.end_exclusive} onChange={e=>change(()=>setDates({...dates,end_exclusive:e.target.value}))}/></label></div><label className="block space-y-1 text-sm">{c.account}<select className="min-h-12 w-full rounded-xl border border-input bg-surface px-3 text-ink" value={account} onChange={e=>change(()=>setAccount(e.target.value))}><option value="">{c.allAccounts}</option>{data?.accounts.filter(a=>a.included&&a.currency==="EUR").map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label className="block space-y-1 text-sm">{c.merchant}<Input value={merchant} maxLength={200} onChange={e=>change(()=>setMerchant(e.target.value))}/></label><DrawerFooter className="px-0"><Button disabled={busy||!datesValid||dates.start>=dates.end_exclusive}>{c.read}</Button><Button variant="outline" type="button" disabled={busy} onClick={()=>{setFiltersOpen(false);void read(dates,account,merchant,null,true);}}>{c.all}</Button></DrawerFooter></form></DrawerContent></Drawer></div>
 <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-caption text-ink-2">{datesValid?`${date(dates.start)} — ${date(new Date(Date.parse(dates.end_exclusive+"T12:00:00Z")-86400000).toISOString().slice(0,10))}`:c.filters}</p>{inventory&&<Drawer><DrawerTrigger asChild><Button variant="ghost" size="chip" className="text-caption text-ink-2"><Info className="size-4"/>{c.basis}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.basis}</DrawerTitle></DrawerHeader><div className="space-y-3 px-4 text-sm"><p>{c.historyNote}</p><p>{c.loaded}: {inventory.total_booked_count}</p><p>{c.period}: {inventory.period_booked_count}</p><p>{inventory.scope.account_ids.length} {c.accounts}</p><p>{c.classificationNote}</p><p>{c.scope}: {dates.start} — {dates.end_exclusive}</p></div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>}</div>
 {inventory&&<div className="flex items-center justify-between gap-3"><Button variant={needsReview?"default":"outline"} size="chip" aria-pressed={needsReview} disabled={busy} onClick={()=>{setNeedsReview(value=>!value);void read(dates,account,merchant,null,false,!needsReview);}}>{needsReview?r.all:r.review} ({inventory.period_unresolved_count})</Button></div>}
 <StatementDates request={request} accountId={account}/>
 {notice&&<p role="status" className="text-caption text-brand">{notice}</p>}
 {busy&&<p role="status" className="text-sm text-ink-2">{c.reading}</p>}{error&&<p role="alert" className="text-sm text-neg">{error}</p>}
 {page&&<section className="space-y-3" aria-label={c.title}><p role="status" className="text-caption text-ink-2">{page.rows.length} {c.shown}</p>{page.rows.length?<ul className="divide-y divide-line">{page.rows.map((row,index)=><li key={row.id} data-ledger-row className="py-2">{(index===0||row.booked_on!==page.rows[index-1].booked_on)&&<h2 className="py-2 text-caption font-semibold text-ink-2">{date(row.booked_on)}</h2>}<button type="button" aria-label={`${r.edit}: ${row.merchant}`} onClick={()=>{setNotice("");setSelected(row);}} className="flex min-h-14 w-full items-center gap-3 rounded-xl text-left focus-visible:outline-brand"><CategoryIcon category={row.economic_flow==="unknown"?"unknown":row.category} size="dense"/><div className="min-w-0 flex-1"><p className="wrap-anywhere text-sm">{row.merchant}</p><p className="text-caption text-ink-2">{row.economic_flow==="internal_transfer"||row.economic_flow==="income"||row.economic_flow==="liability_settlement"?r[row.economic_flow]:row.category==="unclassified"?c.unknown:categoryLabel(row.category,t)}</p></div><span className={`shrink-0 text-sm font-semibold ${row.amount_minor<0?"text-neg":"text-pos"}`}>{euros(row.amount_minor)}</span></button></li>)}</ul>:<p className="py-6 text-sm text-ink-2">{c.empty}</p>}{page.next_cursor&&<Button variant="outline" className="w-full" disabled={busy} onClick={()=>void read(dates,account,merchant,page.next_cursor)}>{c.next}</Button>}</section>}{selected&&page&&<ClassificationSheet key={selected.id} row={selected} version={page.scope.data_version} request={request} close={()=>setSelected(null)} saved={()=>{setSelected(null);setNotice(r.saved);void read(dates,account,merchant);}}/>}</div>;
}
