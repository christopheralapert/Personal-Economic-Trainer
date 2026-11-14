"use client";
import {createContext,useContext,useState,useEffect,type ReactNode} from "react";
import {type Key,type Locale} from "./dictionaries";
import {translate} from "./translate";
export {translate,categoryKey,categoryLabel,basketLabel} from "./translate";
export {type Key,type Locale} from "./dictionaries";
type State={locale:Locale;setLocale:(locale:Locale)=>void;savings:number;setSavings:(n:number)=>void;privacy:boolean;setPrivacy:(value:boolean)=>void;voiceProvider:"browser"|"gemini";setVoiceProvider:(value:"browser"|"gemini")=>void;t:(key:Key,values?:Record<string,string|number>)=>string};
const Context=createContext<State|null>(null);
export function Preferences({children}:{children:ReactNode}) {
  const [locale,changeLocale]=useState<Locale>("en"),[savings,changeSavings]=useState(10),[privacy,changePrivacy]=useState(true);
  const [voiceProvider,changeVoiceProvider]=useState<"browser"|"gemini">("browser");
  useEffect(()=>{try{if(localStorage.getItem("money-coach-voice-provider.v1")==="gemini")changeVoiceProvider("gemini");}catch{}},[]);
  function setVoiceProvider(value:"browser"|"gemini"){changeVoiceProvider(value);try{localStorage.setItem("money-coach-voice-provider.v1",value);}catch{}}
  useEffect(()=>{try{changePrivacy(localStorage.getItem("money-coach-privacy.v1")!=="false");}catch{}},[]);
  function setPrivacy(value:boolean){changePrivacy(value);try{localStorage.setItem("money-coach-privacy.v1",String(value));}catch{}}
  useEffect(()=>{try{const raw=localStorage.getItem("money-coach-preferences.v1");if(raw && raw.length<1000){const value=JSON.parse(raw);if(["en","fi","et"].includes(value.locale))changeLocale(value.locale);if(Number.isInteger(value.savings)&&value.savings>=0&&value.savings<=100){let carried=false;try{const plan=JSON.parse(localStorage.getItem("money-coach-basket-plan.v1")??"null");carried=value.savingsSource!=="user" && plan?.savingsPercent===value.savings;}catch{}changeSavings(carried ? 10 : value.savings);}}}catch{}},[]);
  function setLocale(value:Locale){changeLocale(value);try{localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:value,savings,savingsSource:"user"}));}catch{}}
  function setSavings(value:number){if(!Number.isInteger(value)||value<0||value>100)return;changeSavings(value);try{localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:value,savingsSource:"user"}));}catch{}}
  return <Context value={{locale,setLocale,savings,setSavings,privacy,setPrivacy,voiceProvider,setVoiceProvider,t:(key,values)=>translate(locale,key,values)}}><div lang={locale}>{children}</div></Context>;
}
export function useCopy() {const state=useContext(Context);if(!state) throw new Error("Preferences required");return state;}
