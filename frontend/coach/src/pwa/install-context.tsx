"use client";
import {createContext,useContext,useEffect,useRef,useState,type ReactNode} from "react";

type Choice={outcome:"accepted"|"dismissed"};
type InstallEvent=Event & {prompt:()=>Promise<unknown>;userChoice:Promise<Choice>};
type Status="unavailable"|"available"|"prompting"|"dismissed"|"accepted"|"installed"|"error";
const Context=createContext<{status:Status;available:boolean;install:()=>Promise<void>}|null>(null);
export function InstallProvider({children}:{children:ReactNode}) {
  const [status,setStatus]=useState<Status>("unavailable"),[available,setAvailable]=useState(false);
  const deferred=useRef<InstallEvent|null>(null),installed=useRef(false),pending=useRef(false),generation=useRef(0);
  useEffect(()=>{
    if(process.env.NODE_ENV!=="production" || !window.isSecureContext) return;
    const activeGeneration=++generation.current;
    const media=window.matchMedia?.("(display-mode: standalone)");
    const complete=()=>{installed.current=true;deferred.current=null;setAvailable(false);setStatus("installed");};
    const mode=()=>{if(media?.matches || (navigator as Navigator & {standalone?:boolean}).standalone) complete();};
    const before=(event:Event)=>{
      if(installed.current || typeof (event as InstallEvent).prompt!=="function" || !(event as InstallEvent).userChoice) return;
      event.preventDefault();deferred.current=event as InstallEvent;
      if(!pending.current) {setAvailable(true);setStatus("available");}
    };
    mode();window.addEventListener("beforeinstallprompt",before);window.addEventListener("appinstalled",complete);media?.addEventListener?.("change",mode);
    return ()=>{generation.current=activeGeneration+1;deferred.current=null;window.removeEventListener("beforeinstallprompt",before);window.removeEventListener("appinstalled",complete);media?.removeEventListener?.("change",mode);};
  },[]);
  async function install() {
    const event=deferred.current;if(!event || pending.current || installed.current) return;
    const current=generation.current;deferred.current=null;pending.current=true;setAvailable(false);setStatus("prompting");
    try {
      // Call directly from the user gesture; each browser event is single-use.
      await event.prompt();const choice=await event.userChoice;
      if(current===generation.current && !installed.current) setStatus(choice.outcome);
    } catch {if(current===generation.current && !installed.current) setStatus("error");}
    finally {if(current===generation.current) {pending.current=false;setAvailable(!installed.current && deferred.current!==null);}}
  }
  return <Context value={{status,available,install}}>{children}</Context>;
}
export function useInstall() {const state=useContext(Context);if(!state) throw new Error("Install provider required");return state;}
