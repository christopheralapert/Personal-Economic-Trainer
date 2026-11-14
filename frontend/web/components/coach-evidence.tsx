"use client";
import {useRef,useState} from "react";
import type {components} from "@contracts";
import {useCopy,categoryLabel} from "@/i18n/context";
import {Button} from "@/components/ui/button";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerTrigger,DrawerFooter,DrawerClose} from "@/components/ui/drawer";
import {aborted,type PrivateRequest} from "./private-session";
import {euros} from "./plan-format";
import {coachCopy} from "../i18n/private-coach";
type Schema=components["schemas"];
export function CoachRecord({row}:{row:Schema["LedgerRowV1"]}){
 const {locale,t}=useCopy(),c=coachCopy[locale];
 return <Drawer><DrawerTrigger asChild><button type="button" className="flex min-h-14 w-full items-center justify-between gap-3 py-2 text-left"><span className="min-w-0"><strong className="block wrap-anywhere text-sm">{row.merchant}</strong><small className="block text-caption text-ink-2">{row.booked_on} · {categoryLabel(row.category,t)} · {row.economic_flow}</small></span><strong className="shrink-0">{euros(row.amount_minor)}</strong></button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.details}</DrawerTitle></DrawerHeader><dl className="divide-y divide-line px-4"><div className="py-3 font-semibold wrap-anywhere">{row.merchant}</div>{[[c.date,row.booked_on],[c.amount,euros(row.amount_minor)],[c.category,categoryLabel(row.category,t)]].map(([name,value])=><div key={name} className="flex min-h-12 justify-between gap-3 py-3 text-sm"><dt>{name}</dt><dd className="font-semibold">{value}</dd></div>)}</dl><DrawerFooter><DrawerClose asChild><Button>{c.done}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>;
}
export function CoachEvidence({request,scope,filters}:{request:PrivateRequest;scope:Schema["LedgerScopeV1"];filters?:Schema["LedgerFilterV1"]}){
 const {locale}=useCopy(),c=coachCopy[locale],epoch=useRef(0);
 const [page,setPage]=useState<Schema["LedgerPageV1"]|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(false);
 const query=new URLSearchParams({start:scope.start,end_exclusive:scope.end_exclusive,currency:scope.currency,status:"booked",spending_only:String(filters?.spending_only??true),limit:"50",expected_data_version:String(scope.data_version)});
 for(const id of scope.account_ids)query.append("account_id",id);
 if(filters?.category)query.set("category",filters.category);if(filters?.merchant)query.set("merchant",filters.merchant);
 async function load(){const current=++epoch.current;setBusy(true);setError(false);setPage(null);try{const next=await request<Schema["LedgerPageV1"]>(`ledger/transactions?${query}`);if(current===epoch.current)setPage(next);}catch(reason){if(current===epoch.current&&!aborted(reason))setError(true);}finally{if(current===epoch.current)setBusy(false);}}
 const history=new URLSearchParams({start:scope.start,end:scope.end_exclusive});if(scope.account_ids.length===1)history.set("account_id",scope.account_ids[0]);
 return <Drawer onOpenChange={open=>{if(open)void load();else epoch.current++;}}><DrawerTrigger asChild><Button variant="outline" className="mt-3">{c.records}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.records}</DrawerTitle></DrawerHeader><div className="max-h-sheet overflow-y-auto px-4 pb-4"><p className="text-sm text-ink-2">{scope.start} — {scope.end_exclusive}</p>{busy&&<p role="status" className="py-4">{c.recording}</p>}{error&&<p role="alert" className="py-4 text-neg">{c.evidenceError}</p>}{page&&<><ul className="divide-y divide-line">{page.rows.map(row=><li key={row.id} data-coach-evidence-row><CoachRecord row={row}/></li>)}</ul>{!page.rows.length&&<p className="py-4 text-sm">{c.noMatches}</p>}{page.next_cursor&&<p className="text-caption text-ink-2">{c.more}</p>}<Button asChild variant="ghost"><a href={`/transactions?${history}`}>{c.history}</a></Button></>}</div><DrawerFooter><DrawerClose asChild><Button variant="outline">{c.done}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>;
}
