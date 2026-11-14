"use client";
import {useEffect,useRef,useState,type ReactNode} from "react";
import {ArrowUp} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {Button} from "./ui/button";
import {Input} from "./ui/input";
const examples:Key[]=["askTaxiShort","askWhatifShort","askSafeShort","askProfileShort"];
export function AskHome({onAsk,busy,trailing}:{onAsk:(question:string)=>void;busy:boolean;trailing?:ReactNode}) {
 const {t}=useCopy(),[draft,setDraft]=useState(""),[example,setExample]=useState(0),field=useRef<HTMLInputElement>(null);
 useEffect(()=>{const timer=setInterval(()=>{if(document.activeElement!==field.current)setExample(value=>(value+1)%examples.length);},5000);return()=>clearInterval(timer);},[]);
 return <form className="space-y-3" onSubmit={event=>{event.preventDefault();if(draft.trim()){onAsk(draft.trim());setDraft("");}}}><div className="flex flex-wrap items-center justify-between gap-3"><label htmlFor="home-question" className="block text-sm text-ink-2">{t("askCoach")}</label>{trailing}</div><div className="flex items-center gap-3"><Input ref={field} id="home-question" aria-label={t("askAnything")} placeholder={t(examples[example])} autoComplete="off" maxLength={2000} value={draft} disabled={busy} onChange={event=>setDraft(event.target.value)}/><Button size="icon" aria-label={t("send")} disabled={busy || !draft.trim()}><ArrowUp className="size-5"/></Button></div></form>;
}
