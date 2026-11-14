"use client";
import {createContext,useContext,useState,useEffect,useRef,type ReactNode} from "react";
import {type Key,type Locale} from "./dictionaries";
import {translate} from "./translate";
import {conversationLanguage,type ConversationLanguage} from '@/coach/conversation-language';
import {loadGeneratedLanguage} from './generated-client';
import {learningCopy} from './learning';
export {translate,categoryKey,categoryLabel,basketLabel} from "./translate";
export {type Key,type Locale} from "./dictionaries";
type State={locale:Locale;uiLanguage:string;setAppLanguage:(language:string)=>Promise<boolean>;languageStatus:string;learning:typeof learningCopy.en;setLocale:(locale:Locale)=>void;conversationLocale:ConversationLanguage;setConversationLocale:(value:ConversationLanguage)=>void;savings:number;setSavings:(n:number)=>void;privacy:boolean;setPrivacy:(value:boolean)=>void;voiceProvider:"browser"|"gemini";setVoiceProvider:(value:"browser"|"gemini")=>void;t:(key:Key,values?:Record<string,string|number>)=>string};
const Context=createContext<State|null>(null);
export function Preferences({children}:{children:ReactNode}) {
  const [locale,changeLocale]=useState<Locale>("en"),[savings,changeSavings]=useState(10),[privacy,changePrivacy]=useState(true);
  const [voiceProvider,changeVoiceProvider]=useState<"browser"|"gemini">("browser");
  const [generated,setGenerated]=useState<{language:string;copy:Record<string,string>}|null>(null),[languageStatus,setLanguageStatus]=useState(''),translationRequest=useRef<AbortController|null>(null);
  useEffect(()=>()=>translationRequest.current?.abort(),[]);
  useEffect(()=>{const cancel=()=>{translationRequest.current?.abort();setLanguageStatus('');};window.addEventListener('money-coach-stop-translation',cancel);return()=>window.removeEventListener('money-coach-stop-translation',cancel);},[]);
  async function setAppLanguage(language:string){
   if(['en','fi','et'].includes(language)){setLocale(language as Locale);return true;}
   if(privacy){setLanguageStatus(translate(locale,'geminiVoicePrivacy'));return false;}
   translationRequest.current?.abort();const controller=new AbortController();translationRequest.current=controller;
   setLanguageStatus('Preparing AI-generated translation…');
   try{const result=await loadGeneratedLanguage(language,controller.signal,(done,total)=>setLanguageStatus(`Preparing AI-generated translation… ${done}/${total}`));if(controller.signal.aborted)return false;setGenerated({language,copy:result.copy});setLanguageStatus(`AI-generated translation · NVIDIA Nemotron. ${result.untranslated?`${result.untranslated} texts remain in English. `:''}Return to English in Settings. Translation quality is not guaranteed.`);return true;}catch{if(!controller.signal.aborted)setLanguageStatus('Translation unavailable. The current language and conversation are unchanged. Try again or choose English in Settings.');return false;}finally{if(translationRequest.current===controller)translationRequest.current=null;}
  }
  const [conversationOverride,changeConversation]=useState<ConversationLanguage|null>(null);
  useEffect(()=>{try{const value=sessionStorage.getItem('money-coach-conversation-language.v1');if(value)changeConversation(conversationLanguage(value));}catch{}},[]);
  function setConversationLocale(value:ConversationLanguage){changeConversation(value);try{sessionStorage.setItem('money-coach-conversation-language.v1',value);}catch{}}
  useEffect(()=>{try{if(localStorage.getItem("money-coach-voice-provider.v1")==="gemini")changeVoiceProvider("gemini");}catch{}},[]);
  function setVoiceProvider(value:"browser"|"gemini"){changeVoiceProvider(value);try{localStorage.setItem("money-coach-voice-provider.v1",value);}catch{}}
  useEffect(()=>{try{changePrivacy(localStorage.getItem("money-coach-privacy.v1")!=="false");}catch{}},[]);
  function setPrivacy(value:boolean){if(value){translationRequest.current?.abort();setLanguageStatus('');window.dispatchEvent(new Event('money-coach-stop-playback'));window.dispatchEvent(new Event('money-coach-stop-listening'));window.dispatchEvent(new Event('money-coach-private'));}changePrivacy(value);try{localStorage.setItem("money-coach-privacy.v1",String(value));}catch{}}
  useEffect(()=>{try{const raw=localStorage.getItem("money-coach-preferences.v1");if(raw && raw.length<1000){const value=JSON.parse(raw);if(["en","fi","et"].includes(value.locale))changeLocale(value.locale);if(Number.isInteger(value.savings)&&value.savings>=0&&value.savings<=100){let carried=false;try{const plan=JSON.parse(localStorage.getItem("money-coach-basket-plan.v1")??"null");carried=value.savingsSource!=="user" && plan?.savingsPercent===value.savings;}catch{}changeSavings(carried ? 10 : value.savings);}}}catch{}},[]);
  function setLocale(value:Locale){translationRequest.current?.abort();setGenerated(null);setLanguageStatus('');changeLocale(value);try{localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale:value,savings,savingsSource:"user"}));}catch{}}
  function setSavings(value:number){if(!Number.isInteger(value)||value<0||value>100)return;changeSavings(value);try{localStorage.setItem("money-coach-preferences.v1",JSON.stringify({locale,savings:value,savingsSource:"user"}));}catch{}}
  const learning=structuredClone(learningCopy[locale]);if(generated)for(const [key,value] of Object.entries(learning)){if(typeof value==='string')(learning as unknown as Record<string,unknown>)[key]=generated.copy[`learn.${key}`]??value;else for(const part of ['body','step'] as const)value[part]=generated.copy[`learn.${key}.${part}`]??value[part];}
  return <Context value={{locale,uiLanguage:generated?.language??locale,setAppLanguage,languageStatus,learning,setLocale,conversationLocale:conversationOverride??locale,setConversationLocale,savings,setSavings,privacy,setPrivacy,voiceProvider,setVoiceProvider,t:(key,values={})=>generated?.copy[key] && !["english","finnish","estonian"].includes(key)?Object.entries(values).reduce((text,[name,value])=>text.replaceAll(`{${name}}`,String(value)),generated.copy[key]):translate(locale,key,values)}}><div lang={generated?.language??locale} dir={/^(ar|he|fa|ur)(-|$)/u.test(generated?.language??locale)?'rtl':'ltr'}>{children}</div></Context>;
}
export function useCopy() {const state=useContext(Context);if(!state) throw new Error("Preferences required");return state;}
