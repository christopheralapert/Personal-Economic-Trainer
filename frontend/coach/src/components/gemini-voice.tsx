"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {useCallback,useEffect,useRef,useState} from "react";
import {Mic,Square,Volume2,VolumeX,X} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {coachFetch} from "@/coach/transport";
import type {CoachMessage} from "@/coach/catalog";
import {Button} from "./ui/button";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";
import {type ConversationLanguage} from '@/coach/conversation-language';
import {dictationHint} from '@/voice/dictation-command';
import {voiceFlow} from '@/i18n/voice-flow';
import {stopAfterSpeechPause} from '@/voice/silence-stop';
import {playPCM,pcmContentType} from '@/voice/pcm-player';

const stopPlayback="money-coach-stop-playback",stopListening="money-coach-stop-listening";
const maxAudioBytes=524288,maxRecordingMs=20000;
function voiceStatus(code:unknown):Key {return code==="voice_disabled" ? "geminiVoiceDisabled" : code==="voice_limit" || code==="voice_busy" || code==="provider_wait" ? "geminiVoiceWait" : "geminiVoiceFailed";}
export function VoiceSettings({embedded=false}:{embedded?:boolean}={}){
 const {t,privacy,voiceProvider,setVoiceProvider}=useCopy(),[enabled,setEnabled]=useState<boolean|null>(null);
 useEffect(()=>{const controller=new AbortController();void coachFetch("/api/voice/capabilities",{signal:controller.signal,cache:"no-store"}).then(response=>response.ok ? response.json() : null).then(value=>setEnabled(value?.enabled===true)).catch(()=>{if(!controller.signal.aborted)setEnabled(false);});return()=>controller.abort();},[]);
 return <section className="space-y-3" aria-label={t("voiceSettings")}>{!embedded && <h3 className="font-semibold">{t("voiceSettings")}</h3>}<RadioGroup aria-label={t("voiceSettings")} value={privacy ? "browser" : voiceProvider} onValueChange={value=>setVoiceProvider(value as "browser"|"gemini")}>
  <label className="flex min-h-14 items-center gap-3"><RadioGroupItem value="browser"/>{t("voiceBrowser")}</label>
  <label className="flex min-h-14 items-center gap-3"><RadioGroupItem value="gemini" disabled={privacy || enabled===false}/>{t("geminiVoice")}</label>
 </RadioGroup><p className="text-sm text-ink-2">{t(privacy ? "geminiVoicePrivacy" : "geminiVoiceDisclosure")}</p>{enabled===false && <p role="status" className="text-sm text-ink-2">{t("geminiVoiceDisabled")}</p>}</section>;
}
export function GeminiVoiceInput({onText,disabled}:{onText:(text:string,detected?:string)=>void;disabled:boolean}){
 const {t,locale,conversationLocale}=useCopy(),[state,setState]=useState<"idle"|"starting"|"recording"|"transcribing">("idle"),[status,setStatus]=useState<Key|null>(null);
 const active=useRef(0),recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),request=useRef<AbortController|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const silence=useRef<(()=>void)|null>(null);
 const clean=useCallback(()=>{silence.current?.();silence.current=null;if(timer.current)clearTimeout(timer.current);timer.current=null;if(recorder.current?.state==="recording")recorder.current.stop();recorder.current=null;stream.current?.getTracks().forEach(track=>track.stop());stream.current=null;},[]);
 const cancel=useCallback(()=>{active.current++;request.current?.abort();request.current=null;clean();setState("idle");setStatus(null);},[clean]);
 useEffect(()=>{window.addEventListener(stopListening,cancel);return()=>{window.removeEventListener(stopListening,cancel);cancel();};},[cancel]);
 useEffect(()=>{if(disabled)cancel();},[disabled,cancel]);
 async function start(){
  if(request.current || disabled)return;
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
   recording.onstop=()=>{if(generation!==active.current)return;clean();const blob=new Blob(chunks,{type:mime});if(!blob.size){request.current=null;setState("idle");setStatus("geminiVoiceFailed");return;}setState("transcribing");void transcribe(blob,generation,controller);};
   recording.start(250);setState("recording");timer.current=setTimeout(()=>recording.state==="recording" && recording.stop(),maxRecordingMs);silence.current=stopAfterSpeechPause(capture,()=>{if(generation===active.current && recording.state==='recording')recording.stop();});
  }catch(error){if(generation!==active.current)return;clean();setState("idle");setStatus((error as {name?:string}).name==="NotAllowedError" ? "speechDenied" : "geminiVoiceFailed");}finally{if(generation===active.current && !recorder.current)request.current=null;}
 }
 async function transcribe(blob:Blob,generation:number,controller:AbortController){
  try {const response=await coachFetch("/api/voice/transcribe",{method:"POST",headers:{"Content-Type":blob.type,"X-Money-Coach-Privacy":"off","X-Money-Coach-Language":conversationLocale},body:blob,signal:controller.signal});const value=await response.json();if(generation!==active.current)return;if(!response.ok){setStatus(voiceStatus(value.error));return;}if(typeof value.text!=="string" || !value.text.trim() || value.text.length>2000){setStatus("geminiVoiceFailed");return;}onText(value.text,typeof value.language==='string'?value.language:undefined);setStatus("geminiTranscriptReady");}
  catch{if(generation===active.current)setStatus("geminiVoiceFailed");}finally{if(generation===active.current){request.current=null;setState("idle");}}
 }
 return <div className="contents">{state!=="idle" ? <div className="order-last flex w-full flex-wrap items-center gap-2">{state==="recording" && <Button type="button" variant="outline" size="chip" onClick={()=>{if(recorder.current?.state==="recording"){setState("transcribing");recorder.current.stop();}}}><Square className="size-5"/>{t("speechStop")}</Button>}<Button type="button" variant="ghost" size="chip" onClick={cancel}><X className="size-5"/>{t("speechCancel")}</Button></div> : <Button type="button" variant="ghost" size="icon" aria-label={t("speechStart")} disabled={disabled} onClick={()=>void start()}><Mic className="size-5"/></Button>}
 {(state!=="idle" || status) && <span role="status" className="order-last w-full text-caption text-ink-2"><span>{status==='geminiVoiceFailed'?voiceFlow[copyLocale(locale)].retry:t(state==="recording" ? "geminiRecording" : state==="transcribing" ? "geminiTranscribing" : state==="starting" ? "geminiVoicePreparing" : status!)}</span>{state==='recording' && <span className="block">{dictationHint[conversationLocale]}</span>}</span>}</div>;
}

export function GeminiReadAloud({message,input,language,disabled=false}:{message:CoachMessage;input?:Record<string,unknown>;language:ConversationLanguage;disabled?:boolean}){
 const audioContext=useRef<AudioContext|null>(null);
 const {t,locale,savings}=useCopy(),{dataset,scope}=useMoneyData(),[busy,setBusy]=useState(false),[preparing,setPreparing]=useState(false),[status,setStatus]=useState<Key|null>(null),audio=useRef<HTMLAudioElement|null>(null),url=useRef<string|null>(null),request=useRef<AbortController|null>(null);
 const part=message.parts.find(value=>value.type.startsWith("tool-") && "state" in value && value.state==="output-available");
 const stop=useCallback(()=>{request.current?.abort();request.current=null;audio.current?.pause();audio.current=null;if(url.current)URL.revokeObjectURL(url.current);url.current=null;void audioContext.current?.close().catch(()=>{});audioContext.current=null;setBusy(false);setPreparing(false);},[]);
 useEffect(()=>{window.addEventListener(stopPlayback,stop);return()=>{window.removeEventListener(stopPlayback,stop);stop();if(url.current)URL.revokeObjectURL(url.current);};},[stop]);
 async function play(){
  if(request.current)return;
  window.dispatchEvent(new Event(stopPlayback));window.dispatchEvent(new Event(stopListening));window.speechSynthesis?.cancel();setStatus(null);
  if(disabled || !input || !part || !("input" in part)){setStatus("geminiVoiceFailed");return;}setBusy(true);setPreparing(true);const clicked=performance.now();let received=clicked,serverTiming='';
  const controller=new AbortController();request.current=controller;
  const current=()=>request.current===controller && !controller.signal.aborted;
  const finish=(failure?:Key)=>{if(!current())return;stop();if(failure)setStatus(failure);};
  try{
   try{audioContext.current=new AudioContext();await audioContext.current.resume();}catch{void audioContext.current?.close().catch(()=>{});audioContext.current=null;}
   if(!current())return;
   const response=await coachFetch("/api/voice/speak",{method:"POST",headers:{"Content-Type":"application/json","X-Money-Coach-Privacy":"off",Accept:audioContext.current?pcmContentType:"audio/wav"},body:JSON.stringify({dataset,scope,locale:language,savingsPercent:savings,tool:part.type.slice(5),input}),signal:controller.signal});
   if(!response.ok){const error=await response.json();finish(voiceStatus(error.error));return;}
   if(response.headers.get('content-type')===pcmContentType && audioContext.current){const context=audioContext.current;await playPCM(response,context,controller.signal,providerMs=>{if(current()){setPreparing(false);const schedulingMs=20+(context.outputLatency??0)*1000;window.dispatchEvent(new CustomEvent('money-coach-audio-timing',{detail:{replay:false,streamed:true,estimatedOutput:true,waitMs:performance.now()-clicked,playbackMs:schedulingMs,totalMs:performance.now()-clicked+schedulingMs,serverTiming:'provider-first;dur='+providerMs}}));}},()=>finish());return;}
   void audioContext.current?.close().catch(()=>{});audioContext.current=null;const blob=await response.blob();if(!current())return;url.current=URL.createObjectURL(blob);serverTiming=response.headers.get('server-timing')??'';received=performance.now();
   const player=new Audio(url.current);player.addEventListener("ended",()=>finish());player.addEventListener("error",()=>finish("geminiVoiceFailed"));player.addEventListener('playing',()=>{if(current()){setPreparing(false);window.dispatchEvent(new CustomEvent('money-coach-audio-timing',{detail:{replay:false,waitMs:received-clicked,playbackMs:performance.now()-received,totalMs:performance.now()-clicked,serverTiming}}));}});audio.current=player;await player.play();if(current())setPreparing(false);
  }catch{finish("geminiVoiceFailed");}
 }
 return <div className="flex flex-wrap items-center gap-2"><Button type="button" variant="ghost" size="chip" disabled={disabled || !part} onClick={busy ? stop : ()=>void play()}>{busy ? <VolumeX className="size-5"/> : <Volume2 className="size-5"/>}{t(busy ? "stopReading" : "readAloud")}</Button><span className="text-caption text-ink-2">{t("geminiVoice")}</span>{preparing && <span role="status" className="w-full text-caption text-ink-2">{voiceFlow[copyLocale(locale)].preparing}</span>}{status && <span role="status" className="w-full text-caption text-ink-2">{t(status)}</span>}</div>;
}
