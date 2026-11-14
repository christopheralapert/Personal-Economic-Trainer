"use client";
import {useCallback,useEffect,useRef,useState,type RefObject} from "react";
import {Mic,Square,Volume2,VolumeX,X} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {Button} from "./ui/button";
import type {CoachMessage,ToolName} from "@/coach/catalog";
import {useSpokenResult} from "@/lib/use-spoken-result";
import {GeminiVoiceInput,GeminiReadAloud} from "./gemini-voice";

type Recognition={lang:string;interimResults:boolean;processLocally?:boolean;start:()=>void;stop:()=>void;abort:()=>void;onresult:((event:{results:ArrayLike<ArrayLike<{transcript:string}>>;resultIndex:number})=>void)|null;onerror:((event:{error:string})=>void)|null;onend:(()=>void)|null};
type RecognitionConstructor={new():Recognition;available?:(options:{langs:string[];processLocally:boolean})=>Promise<string>};
const language={en:"en-US",fi:"fi-FI",et:"et-EE"} as const;
function recognitionConstructor():RecognitionConstructor|undefined {const value=window as unknown as {SpeechRecognition?:RecognitionConstructor;webkitSpeechRecognition?:RecognitionConstructor};return value.SpeechRecognition??value.webkitSpeechRecognition;}

export function VoiceInput({onText,disabled}:{onText:(text:string)=>void;disabled:boolean}) {
 const {privacy,voiceProvider,locale}=useCopy();return !privacy && voiceProvider==="gemini" ? <GeminiVoiceInput key={locale} onText={onText} disabled={disabled}/> : <BrowserVoiceInput key={`${locale}:${privacy}`} onText={onText} disabled={disabled}/>;
}
function BrowserVoiceInput({onText,disabled}:{onText:(text:string)=>void;disabled:boolean}) {
 const {t,locale,privacy}=useCopy(),[listening,setListening]=useState(false),[preparing,setPreparing]=useState(false),[status,setStatus]=useState<Key|null>(null),current=useRef<Recognition|null>(null),generation=useRef(0);
 useEffect(()=>()=>{generation.current++;current.current?.abort();current.current=null;},[privacy,locale]);
 useEffect(()=>{if(disabled){generation.current++;current.current?.abort();current.current=null;setListening(false);setPreparing(false);}},[disabled]);
 useEffect(()=>{const cancelInput=()=>{generation.current++;current.current?.abort();current.current=null;setListening(false);setPreparing(false);};window.addEventListener("money-coach-stop-listening",cancelInput);return()=>window.removeEventListener("money-coach-stop-listening",cancelInput);},[]);
 async function start() {
  window.dispatchEvent(new Event("money-coach-stop-playback"));window.speechSynthesis?.cancel();
  const attempt=++generation.current,Constructor=recognitionConstructor();setStatus(null);
  if(!Constructor){setStatus("speechUnavailable");return;}
  let recognizer:Recognition;try{recognizer=new Constructor();}catch{setStatus("speechUnavailable");return;}
  if(privacy) {
   if(!("processLocally" in recognizer) || typeof Constructor.available!=="function") {setStatus("speechLocalUnavailable");return;}
   setPreparing(true);let availability:string;try{availability=await Constructor.available({langs:[language[locale]],processLocally:true});}catch{availability="unavailable";}
   if(attempt!==generation.current)return;
   setPreparing(false);
   if(availability!=="available") {setStatus("speechLocalUnavailable");return;}
   try {recognizer.processLocally=true;if(recognizer.processLocally!==true) throw new Error("local mode unavailable");} catch {setStatus("speechLocalUnavailable");return;}
  }
  recognizer.lang=language[locale];recognizer.interimResults=false;current.current=recognizer;
  // Keep recognition private to this capture until it ends; Cancel preserves the draft.
  let transcript="";
  recognizer.onresult=event=>{if(attempt===generation.current){transcript=Array.from(event.results).map(result=>result[0]?.transcript??"").join(" ").trim();}};
  recognizer.onerror=event=>{if(attempt===generation.current){generation.current++;current.current=null;setListening(false);setStatus(event.error==="not-allowed" || event.error==="service-not-allowed" ? "speechDenied" : event.error==="language-not-supported" || event.error==="language-unavailable" ? "speechLocalUnavailable" : "speechUnavailable");recognizer.abort();}};
  recognizer.onend=()=>{if(attempt===generation.current){generation.current++;setListening(false);current.current=null;if(transcript)onText(transcript.slice(0,2000));}};
  try{setListening(true);recognizer.start();}catch{generation.current++;current.current=null;setListening(false);setStatus("speechUnavailable");}
 }
 function cancel(){generation.current++;current.current?.abort();current.current=null;setListening(false);setPreparing(false);setStatus(null);}
 return <div className="contents">{listening || preparing ? <div className="order-last flex w-full flex-wrap items-center gap-2">{listening && <Button type="button" variant="outline" size="chip" onClick={()=>current.current?.stop()}><Square className="size-5"/>{t("speechStop")}</Button>}<Button type="button" variant="ghost" size="chip" onClick={cancel}><X className="size-5"/>{t("speechCancel")}</Button><span role="status" className="text-caption text-ink-2">{t(listening ? "speechListening" : "geminiVoicePreparing")}</span></div> : <Button type="button" variant="ghost" size="icon" aria-label={t("speechStart")} disabled={disabled} onClick={()=>void start()}><Mic className="size-5"/></Button>}{status && <span role="status" className="order-last w-full text-caption text-ink-2">{t(status)}</span>}</div>;
}

export function ReadAloud({article,message}:{article:RefObject<HTMLElement|null>;message:CoachMessage}) {
 const {privacy,voiceProvider,locale,savings}=useCopy();
 const part=message.parts.find(value=>value.type.startsWith("tool-") && "state" in value && value.state==="output-available" && "input" in value && "output" in value);
 const current=useSpokenResult(part ? part.type.slice(5) as ToolName : null,part && "input" in part ? part.input : {},part && "output" in part ? part.output : {});
 const key=JSON.stringify([message.id,locale,savings,current?.input]);
 return !privacy && voiceProvider==="gemini" ? <GeminiReadAloud key={key} message={message} input={current?.input} disabled={!current?.speakable}/> : <BrowserReadAloud key={key} article={article} disabled={current?.speakable===false}/>;
}
function BrowserReadAloud({article,disabled=false}:{article:RefObject<HTMLElement|null>;disabled?:boolean}) {
 const {t,locale,privacy}=useCopy(),[speaking,setSpeaking]=useState(false),[error,setError]=useState(false),[available,setAvailable]=useState(false);
 const generation=useRef(0);
 const stop=useCallback(()=>{generation.current++;window.speechSynthesis?.cancel();setSpeaking(false);},[]);
 useEffect(()=>{const synth=window.speechSynthesis;if(!synth)return;const refresh=()=>setAvailable(synth.getVoices().some(item=>item.lang.toLowerCase().split("-")[0]===locale && (!privacy || item.localService===true)));refresh();synth.addEventListener("voiceschanged",refresh);return()=>synth.removeEventListener("voiceschanged",refresh);},[locale,privacy]);
 useEffect(()=>()=>{generation.current++;if(typeof window!=="undefined")window.speechSynthesis?.cancel();},[privacy,locale]);
 useEffect(()=>{window.addEventListener("money-coach-stop-playback",stop);return()=>window.removeEventListener("money-coach-stop-playback",stop);},[stop]);
 function play(){setError(false);const synth=window.speechSynthesis,text=article.current?.querySelector("[data-spoken-answer]")?.textContent?.trim();
  if(!synth || !text){setError(true);return;}
  const voice=synth.getVoices().find(item=>item.lang.toLowerCase().split("-")[0]===locale && (!privacy || item.localService===true));
  if(!voice){setError(true);return;}
  try {window.dispatchEvent(new Event("money-coach-stop-playback"));window.dispatchEvent(new Event("money-coach-stop-listening"));const attempt=++generation.current,utterance=new SpeechSynthesisUtterance(text);utterance.lang=language[locale];utterance.voice=voice;utterance.onend=()=>{if(attempt===generation.current){generation.current++;setSpeaking(false);}};utterance.onerror=()=>{if(attempt===generation.current){generation.current++;setSpeaking(false);setError(true);}};setSpeaking(true);synth.speak(utterance);} catch {generation.current++;setSpeaking(false);setError(true);}
 }
 return <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" size="chip" disabled={disabled || (!available && !speaking)} onClick={speaking ? stop : play}>{speaking ? <VolumeX className="size-5"/> : <Volume2 className="size-5"/>}{t(speaking ? "stopReading" : "readAloud")}</Button>{(error || !available || disabled) && <span role="status" className="text-caption text-ink-2">{t("voiceUnavailable")}</span>}</div>;
}
