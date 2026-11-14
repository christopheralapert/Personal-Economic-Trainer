"use client";
import {useEffect,useState} from "react";
import {useCopy} from "@/i18n/context";
import type {PrivateRequest} from "./private-session";
export type StatementAccount={id:string;name:string;currency:string;last_statement_date:string};
export function StatementDates({request,accountId=""}:{request:PrivateRequest;accountId?:string}){
 const {locale}=useCopy(),[accounts,setAccounts]=useState<StatementAccount[]>([]);
 useEffect(()=>{let active=true;const load=()=>void request<StatementAccount[]>("statements/wise/accounts").then(v=>{if(active)setAccounts(v);}).catch(()=>{});load();window.addEventListener('moneylens-data-changed',load);return()=>{active=false;window.removeEventListener('moneylens-data-changed',load);};},[request]);
 const label={en:'Last statement date',fi:'Tiliotteen viimeinen päivä',et:'Väljavõtte viimane kuupäev'}[locale];
 return <>{accounts.filter(a=>!accountId||a.id===accountId).map(a=><p key={a.id} data-statement-date className="text-caption text-ink-2">{a.name} · {label}: {a.last_statement_date}</p>)}</>;
}
