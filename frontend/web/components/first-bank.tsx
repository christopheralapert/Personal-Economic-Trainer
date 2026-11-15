"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {useEffect,useState} from "react";
import {Landmark,ChevronRight} from "lucide-react";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {useCopy} from "@/i18n/context";
import {firstBankCopy} from "../i18n/first-bank";

export const bankCountries=["EE","FI","LV","LT","SE"] as const;
export function preferredBankCountry(){
 try{const stored=localStorage.getItem("money-coach-bank-country.v1");if(bankCountries.includes(stored as typeof bankCountries[number]))return stored!;}catch{}
 const region=new Intl.Locale(navigator.language).maximize().region;return bankCountries.includes(region as typeof bankCountries[number])?region!:"EE";
}
export function rememberBankCountry(value:string){try{localStorage.setItem("money-coach-bank-country.v1",value);}catch{}}
export function FirstBankCard(){const {locale}=useCopy(),c=firstBankCopy[copyLocale(locale)];return <section data-first-bank className="my-6 space-y-6 rounded-3xl border border-line bg-surface p-6"><div className="space-y-3"><Landmark className="size-6 text-brand"/><h1 className="text-xl font-semibold">{c.connect}</h1><p className="text-sm text-ink-2">{c.intro}</p></div><div className="grid gap-3"><Button asChild className="w-full"><a href="/banks?connect=1">{c.connect}</a></Button><Button asChild variant="outline" className="w-full"><a href="/demo?dataset=organizer1">{c.demo}</a></Button></div></section>;}

export function BankPicker({country,onCountry,filter,onFilter,banks,loading,error,retry,choose,simulated=false,heading=true}:{heading?:boolean;country:string;onCountry:(v:string)=>void;filter:string;onFilter:(v:string)=>void;banks:{name:string;country:string;id?:string}[];loading:boolean;error:string;retry:()=>void;choose:(bank:{name:string;country:string;id?:string})=>void;simulated?:boolean}){
 const {locale}=useCopy(),c=firstBankCopy[copyLocale(locale)];const [ready,setReady]=useState(false),[visible,setVisible]=useState(6);
 useEffect(()=>{setReady(true);},[]);
 useEffect(()=>{setVisible(6);},[country,filter]);
 return <section className="space-y-4" aria-label={c.pick}>{heading&&<h1 className="text-xl font-semibold">{c.pick}</h1>}{simulated&&<p className="text-sm text-ink-2">{c.simulated}</p>}<label className="grid gap-1 text-sm">{c.country}<select aria-label={c.country} className="min-h-12 rounded-xl border border-line bg-surface px-3 text-ink" value={country} onChange={e=>{rememberBankCountry(e.target.value);onCountry(e.target.value);}}>{bankCountries.map(code=><option key={code} value={code}>{ready?new Intl.DisplayNames([locale],{type:"region"}).of(code):code}</option>)}</select></label><label className="grid gap-1 text-sm">{c.search}<Input type="search" value={filter} onChange={e=>onFilter(e.target.value)} /></label>{loading?<p role="status" className="py-4 text-sm text-ink-2">{c.loading}{simulated&&<a href="/demo/banks" onClick={event=>{event.preventDefault();retry();}} className="ml-3 text-brand underline underline-offset-4">{c.retry}</a>}</p>:error?<div role="alert" className="space-y-3"><p className="text-sm">{error}</p><Button variant="outline" onClick={retry}>{c.retry}</Button></div>:banks.length===0?<p role="status" className="py-4 text-sm text-ink-2">{c.empty}</p>:<><ul className="divide-y divide-line">{banks.slice(0,visible).map(bank=><li key={bank.id??`${bank.country}:${bank.name}`}><button className="flex min-h-14 w-full items-center justify-between gap-3 py-3 text-left text-ink focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>choose(bank)}><span>{bank.name}</span><ChevronRight className="size-5 shrink-0"/></button></li>)}</ul>{banks.length>visible&&<Button variant="outline" className="w-full" onClick={()=>setVisible(value=>value+20)}>{c.showMore.replace("{shown}",String(Math.min(visible,banks.length))).replace("{total}",String(banks.length))}</Button>}</>}</section>;
}
