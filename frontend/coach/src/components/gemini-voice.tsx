"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import {Mic,Square,Volume2,VolumeX,X} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {coachFetch} from "@/coach/transport";
import type {CoachMessage} from "@/coach/catalog";
import {Button} from "./ui/button";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";

const stopPlayback="money-coach-stop-playback",stopListening="money-coach-stop-listening";
const maxAudioBytes=524288,maxRecordingMs=20000;
function voiceStatus(code:unknown):Key {return code==="voice_disabled" ? "geminiVoiceDisabled" : code==="voice_limit" || code==="voice_busy" || code==="provider_wait" ? "geminiVoiceWait" : "geminiVoiceFailed";}
export function VoiceSettings(){
 const {t,privacy,voiceProvider,setVoiceProvider}=useCopy(),[enabled,setEnabled]=useState<boolean|null>(null);
 useEffect(()=>{const controller=new AbortController();void coachFetch("/api/voice/capabilities",{signal:controller.signal,cache:"no-store"}).then(response=>response.ok ? response.json() : null).then(value=>setEnabled(value?.enabled===true)).catch(()=>{if(!controller.signal.aborted)setEnabled(false);});return()=>controller.abort();},[]);
 return <section className="space-y-3"><h3 className="font-semibold">{t("voiceSettings")}</h3><RadioGroup aria-label={t("voiceSettings")} value={privacy ? "browser" : voiceProvider} onValueChange={value=>setVoiceProvider(value as "browser"|"gemini")}>
  <label className="flex min-h-14 items-center gap-3"><RadioGroupItem value="browser"/>{t("voiceBrowser")}</label>
  <label className="flex min-h-14 items-center gap-3"><RadioGroupItem value="gemini" disabled={privacy || enabled===false}/>{t("geminiVoice")}</label>
 </RadioGroup><p className="text-sm text-ink-2">{t(privacy ? "geminiVoicePrivacy" : "geminiVoiceDisclosure")}</p>{enabled===false && <p role="status" className="text-sm text-ink-2">{t("geminiVoiceDisabled")}</p>}</section>;
}
export function GeminiVoiceInput({onText,disabled}:{onText:(text:string)=>void;disabled:boolean}){
 const {t,locale}=useCopy(),[state,setState]=useState<"idle"|"starting"|"recording"|"transcribing">("idle"),[status,setStatus]=useState<Key|null>(null);
 const active=useRef(0),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),request=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const clean=useCallback(()=>{if(timer.current)clearTimeout(timer.current);timer.current=null;if(recorder.current?.state==="recording")recorder.current.stop();recorder.current=null;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
 const cancel=useCallback(()=>{active.current++;request.current?.abort();request.current=null;clean();setState("idle");setStatus(null);},[clean]);
 useEffect(()=>{window.addEventListener(stopListening,cancel);return()=>{window.removeEventListener(stopListening,cancel);cancel();};},[cancel]);
 useEffect(()=>{if(disabled)cancel();},[disabled,cancel]);
 async function start(){
  const generation=++active.current;setStatus(null);setState("starting");window.dispatchEvent(new Event(stopPlayback));
  const controller=new AbortController();request.current=controller;
  try {
   const capability=await coachFetch("/api/voice/capabilities",{signal:controller.signal,cache:"no-store"}),configuration=await capability.json();if(generation!==active.current)return;if(!configuration.enabled){setStatus("geminiVoiceDisabled");setState("idle");return;}
   if(typeof MediaRecorder==="undefined" || !navigator.mediaDevices?.getUserMedia){setStatus("speechUnavailable");setState("idle");return;}
   const mime=["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(value=>MediaRecorder.isTypeSupported(value));if(!mime){setStatus("speechUnavailable");setState("idle");return;}
   const capture=await navigator.mediaDevices.getUserMedia({audio:true});if(generation!==active.current){capture.getTracks().forEach(track=>track.stop());return;}stream.current=capture;
   const recording=new MediaRecorder(capture,{mimeType:mime});recorder.current=recording;const chunks:Blob[]=[];let bytes=0;
   recording.ondataavailable=event=>{if(generation!==active.current || !event.data.size)return;bytes+=event.data.size;if(bytes>maxAudioBytes){cancel();setStatus("geminiVoiceTooLong");return;}chunks.push(event.data);};
   recording.onerror=()=>{if(generation===active.current){cancel();setStatus("speechUnavailable");}};
   recording.onstop=()=>{if(generation!==active.current)return;clean();const blob=new Blob(chunks,{type:mime});if(!blob.size){setState("idle");setStatus("geminiVoiceFailed");return;}setState("transcribing");void transcribe(blob,generation,controller);};
   recording.start(250);setState("recording");timer.current=setTimeout(()=>recording.state==="recording" && recording.stop(),maxRecordingMs);
  }catch(error){if(generation!==active.current)return;clean();setState("idle");setStatus((error as {name?:string}).name==="NotAllowedError" ? "speechDenied" : "geminiVoiceFailed");}
 }
 async function transcribe(blob:Blob,generation:number,controller:AbortController){
  try {const response=await coachFetch("/api/voice/transcribe",{method:"POST",headers:{"Content-Type":blob.type,"X-Money-Coach-Privacy":"off","X-Money-Coach-Language":locale},body:blob,signal:controller.signal});const value=await response.json();if(generation!==active.current)return;if(!response.ok){setStatus(voiceStatus(value.error));return;}if(typeof value.text!=="string" || !value.text.trim() || value.text.length>2000){setStatus("geminiVoiceFailed");return;}onText(value.text);setStatus("geminiTranscriptReady");}
  catch{if(generation===active.current)setStatus("geminiVoiceFailed");}finally{if(generation===active.current)setState("idle");}
 }
 return <div className="contents">{state!=="idle" ? <div className="order-last flex w-full flex-wrap items-center gap-2">{state==="recording" && <Button type="button" variant="outline" size="chip" onClick={()=>recorder.current?.stop()}><Square className="size-5"/>{t("speechStop")}</Button>}<Button type="button" variant="ghost" size="chip" onClick={cancel}><X className="size-5"/>{t("speechCancel")}</Button></div> : <Button type="button" variant="ghost" size="icon" aria-label={t("speechStart")} disabled={disabled} onClick={()=>void start()}><Mic className="size-5"/></Button>}
 {(state!=="idle" || status) && <span role="status" className="order-last w-full text-caption text-ink-2">{t(state==="recording" ? "geminiRecording" : state==="transcribing" ? "geminiTranscribing" : state==="starting" ? "geminiVoicePreparing" : status!)}</span>}</div>;
}

export function GeminiReadAloud({message,input,disabled=false}:{message:CoachMessage;input?:Record<string,unknown>;disabled?:boolean}){
 const {t,locale,savings}=useCopy(),{dataset,scope}=useMoneyData(),[busy,setBusy]=useState(false),[status,setStatus]=useState<Key|null>(null),audio=useRef<HTMLAudioElement|null>(null),url=useRef<string|null>(null),request=useRef<AbortController|null>(null);
 const part=message.parts.find(value=>value.type.startsWith("tool-") && "state" in value && value.state==="output-available");
 const stop=useCallback(()=>{request.current?.abort();request.current=null;audio.current?.pause();setBusy(false);},[]);
 useEffect(()=>{window.addEventListener(stopPlayback,stop);return()=>{window.removeEventListener(stopPlayback,stop);stop();if(url.current)URL.revokeObjectURL(url.current);};},[stop]);
 async function play(){
  window.dispatchEvent(new Event(stopPlayback));window.dispatchEvent(new Event(stopListening));window.speechSynthesis?.cancel();setStatus(null);
  if(disabled || !input || !part || !("input" in part)){setStatus("geminiVoiceFailed");return;}setBusy(true);
  const controller=new AbortController();request.current=controller;
  const current=()=>request.current===controller && !controller.signal.aborted;
  const finish=(failure?:Key)=>{if(!current())return;request.current=null;setBusy(false);if(failure)setStatus(failure);};
  try{
   if(!url.current){const response=await coachFetch("/api/voice/speak",{method:"POST",headers:{"Content-Type":"application/json","X-Money-Coach-Privacy":"off"},body:JSON.stringify({dataset,scope,locale,savingsPercent:savings,tool:part.type.slice(5),input}),signal:controller.signal});if(!response.ok){const error=await response.json();finish(voiceStatus(error.error));return;}const blob=await response.blob();if(!current())return;url.current=URL.createObjectURL(blob);}
   if(!current())return;const player=new Audio(url.current);player.addEventListener("ended",()=>finish());player.addEventListener("error",()=>finish("geminiVoiceFailed"));audio.current=player;await player.play();
  }catch{finish("geminiVoiceFailed");}
 }
 return <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" size="chip" disabled={disabled || !part} onClick={busy ? stop : ()=>void play()}>{busy ? <VolumeX className="size-5"/> : <Volume2 className="size-5"/>}{t(busy ? "stopReading" : "readAloud")}</Button><span className="text-caption text-ink-2">{t("geminiVoice")}</span>{status && <span role="status" className="w-full text-caption text-ink-2">{t(status)}</span>}</div>;
}
