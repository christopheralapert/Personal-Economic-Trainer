"use client";
import {sourceDate} from "@/engine/source-date";
import {OverviewFocus} from "./overview-focus";
import {useMoneyData} from "@/lib/money-data-context";
import {DatasetPicker} from "./dataset-picker";
import {PersonalizedLearn} from "./personalized-learn";
import {MyDataPanel} from "./my-data-panel";
import {ConversationEntry} from "./conversation-entry";
import {QuestionGrid} from "./question-grid";
import {usePlanning} from "@/lib/planning-context";
import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {useChat} from "@ai-sdk/react";
import {DefaultChatTransport} from "ai";
import {ArrowUp,BookOpen,ChartNoAxesColumn,ChevronLeft,MessageCircle,Settings,SlidersHorizontal,Trash2} from "lucide-react";
import {toast} from "sonner";
import {useCopy,type Locale} from "@/i18n/context";
import {overviewIncome} from "@/lib/overview-model";
import {money,date,percent} from "@/lib/format";
import {useKeyboardViewport} from "@/lib/use-keyboard-viewport";
import {demo,basisPointAmount,type Period} from "@/engine";
import {type CoachMessage} from "@/coach/catalog";
import {RuleProvider} from "@/coach/rule-provider";
import {coachFetch,prepareCoachRequest} from "@/coach/transport";
import type {SavingsGoal} from "@/lib/savings-goal";
import {Simulator} from "./simulator";
import {ViewScope} from "@/lib/view-state";
import {displayedContext} from "@/coach/displayed-context";
import {isFollowUpQuestion,type QuestionContext} from "@/coach/question-context";
import {createViewStore} from "@/lib/view-store";
import {SavingsGoalFlow} from "./savings-goal";
import {Button} from "./ui/button";
import {Input} from "./ui/input";
import {VoiceInput} from "./speech-controls";
import {VoiceSettings} from "./gemini-voice";
import {Tabs,TabsList,TabsTrigger,TabsContent} from "./ui/tabs";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";
import {Slider} from "./ui/slider";
import {Skeleton} from "./ui/skeleton";
import {Toaster} from "./ui/sonner";
import {ConnectedBanks} from "./connected-banks";
import {InstallApp} from "./install-app";
import {CategoryLimit} from "./category-limit";
import {MonthlyPlans} from "./monthly-plans";
import {DataSourceDetails} from "./data-source-details";
import {SettingsGroup,SettingsRow,SettingsSheetRow} from "./settings-list";
import {Switch} from "./ui/switch";
import {bankSummaries} from "@/engine";
import {acknowledgement,languageCommand,languageConfirmation,localLanguageUnavailable,appLanguageUnavailable,type ConversationLanguage} from '@/coach/conversation-language';
import {appLanguageCommand} from '@/coach/app-language-command';

const tabs=[{key:"overview",Icon:ChartNoAxesColumn},{key:"coach",Icon:MessageCircle},{key:"whatif",Icon:SlidersHorizontal},{key:"learn",Icon:BookOpen}] as const;
export function MoneyCoach({embeddedDemo=false,onlineCoachEnabled=false}:{embeddedDemo?:boolean;onlineCoachEnabled?:boolean}={}) {
  const {ready:sourceReady,loadError,data,dataset,scope,signature,controlsOpen,closeControls}=useMoneyData();
  const snapshot=sourceDate(data.as_of);
  const {locale,setLocale,setAppLanguage,languageStatus,conversationLocale,setConversationLocale,savings,privacy,setPrivacy,voiceProvider,t}=useCopy(),[tab,setTab]=useState("overview"),[settings,setSettings]=useState(false),[goal,setGoal]=useState(false),[savedGoal,setSavedGoal]=useState<SavingsGoal|null>(null),[requestFailed,setRequestFailed]=useState(false);
  useEffect(()=>{const requested=new URLSearchParams(window.location.search).get("tab");if(["overview","coach","whatif","learn"].includes(requested??""))setTab(requested!);},[]);
  const {period}=usePlanning();
  const [input,setInput]=useState(""),[localBusy,setLocalBusy]=useState(false),[fallback,setFallback]=useState(false);
  const [chatViews,setChatViews]=useState(createViewStore),[visitViews]=useState(createViewStore),[goalOrigin,setGoalOrigin]=useState<"settings"|"coach">("settings");
  const latest=useRef(0),pending=useRef<{question:string;messages:CoachMessage[];locale:Locale;language:ConversationLanguage;savings:number;generation:number;period:Period;data:typeof demo;signature:string;context?:QuestionContext}|null>(null),end=useRef<HTMLDivElement>(null);
  const sending=useRef(false),focusDraft=useRef(false),questionInput=useRef<HTMLInputElement>(null);
  const bindQuestionInput=useCallback((node:HTMLInputElement|null)=>{
    questionInput.current=node;
    if(node && focusDraft.current && !node.disabled){node.focus({preventScroll:true});focusDraft.current=false;}
  },[]);
  const transport=useMemo(()=>new DefaultChatTransport<CoachMessage>({api:"/api/chat",fetch:coachFetch,prepareSendMessagesRequest:prepareCoachRequest}),[]);
  const chat=useChat<CoachMessage>({id:`money-coach:conversation:${signature}`,transport,onError:()=>{void localAnswer();}});
  const setMessages=chat.setMessages;
  const lastScroll=useRef("");
  const messageViews=useRef(new Map<string,ReturnType<typeof createViewStore>>());
  useEffect(()=>{
    if(!sourceReady)return;
    latest.current++;pending.current=null;sending.current=false;setLocalBusy(false);
    setChatViews(messageViews.current.get(signature)??createViewStore());
    setMessages([]);
  },[sourceReady,signature,setMessages]);
  useEffect(()=>{messageViews.current.set(signature,chatViews);},[signature,chatViews]);
  const busy=localBusy || chat.status==="submitted" || chat.status==="streaming";
  useKeyboardViewport((tab==="coach" && !settings && !goal && !controlsOpen));
  async function localAnswer() {
    const current=pending.current;if(!current || current.generation!==latest.current) return;
    pending.current=null;setLocalBusy(true);
    try {
      const question=languageCommand(current.question)?.question||current.question;
      const answer:CoachMessage=['en','fi','et'].includes(current.language)?{...await new RuleProvider().answer(question,current.language as Locale,current.savings,{context:current.context,period:current.period,data:current.data}),metadata:{answerMode:"rule",language:current.language}}:{id:crypto.randomUUID(),role:'assistant',parts:[{type:'text',text:localLanguageUnavailable(current.locale)}],metadata:{answerMode:'rule',language:current.locale}};
      if(current.generation!==latest.current) return;
      const messages:CoachMessage[]=[...current.messages,{id:crypto.randomUUID(),role:"user",parts:[{type:"text",text:current.question}]},answer];
      chat.setMessages(messages);
      setFallback(true);
    } catch {if(current.generation===latest.current) setRequestFailed(true);}
    finally {if(current.generation===latest.current){sending.current=false;setLocalBusy(false);}}
  }
  async function ask(question:string) {
    if(sending.current || busy || !question.trim()) return;
    window.dispatchEvent(new Event("money-coach-stop-listening"));
    sending.current=true;question=question.trim();
    const generation=++latest.current;setInput("");setTab("coach");setSettings(false);setGoal(false);setFallback(false);setRequestFailed(false);
    const requestedAppLanguage=appLanguageCommand(question);
    if(requestedAppLanguage){
      setLocalBusy(true);const changed=await setAppLanguage(requestedAppLanguage);if(generation!==latest.current)return;
      if(['en','fi','et','es','ja'].includes(requestedAppLanguage)&&changed)setConversationLocale(requestedAppLanguage as 'en'|'fi'|'et'|'es'|'ja');
      chat.setMessages([...chat.messages,{id:crypto.randomUUID(),role:'user',parts:[{type:'text',text:question}]},{id:crypto.randomUUID(),role:'assistant',metadata:{answerMode:'rule'},parts:[{type:'text',text:changed?`Interface language: ${new Intl.DisplayNames([requestedAppLanguage],{type:'language'}).of(requestedAppLanguage)}.`:appLanguageUnavailable(locale)}]}]);setLocalBusy(false);sending.current=false;return;
    }
    const command=languageCommand(question),language=command?.language??conversationLocale;
    let immediate:string|null=null;
    if(command?.scope==='app'){
      if(['en','fi','et'].includes(language)){setLocale(language as Locale);setConversationLocale(language);immediate=languageConfirmation[language];}
      else immediate=appLanguageUnavailable(locale);
    }else if(command){if(command.scope==='conversation')setConversationLocale(language);if(!command.question)immediate=languageConfirmation[language];}
    const financialQuestion=command?.question||question;
    immediate??=acknowledgement(financialQuestion,language);
    if(!immediate && privacy && !['en','fi','et'].includes(language))immediate=localLanguageUnavailable(locale);
    if(immediate){chat.setMessages([...chat.messages,{id:crypto.randomUUID(),role:'user',parts:[{type:'text',text:question}]},{id:crypto.randomUUID(),role:'assistant',metadata:{answerMode:'rule',language:command?.scope==='app' && !['en','fi','et'].includes(language)?locale:language},parts:[{type:'text',text:immediate}]}]);sending.current=false;return;}
    const context=isFollowUpQuestion(financialQuestion) ? displayedContext(chat.messages,chatViews) : undefined;
    pending.current={question,messages:chat.messages,locale,language,savings,generation,context,period,data,signature};
    try {
      if(!navigator.onLine) {await localAnswer();return;}
      await chat.sendMessage({text:question},{body:{locale,conversationLanguage:language,savingsPercent:savings,privacy,period,scope,dataset,...(context ? {context} : {})}});
    } catch {if(generation===latest.current) await localAnswer();}
    finally {if(generation===latest.current && pending.current){pending.current=null;sending.current=false;}}
  }
  function stop() {latest.current++;pending.current=null;sending.current=false;window.dispatchEvent(new Event('money-coach-stop-translation'));void chat.stop();setLocalBusy(false);}
  function clear() {stop();setConversationLocale(locale);setChatViews(createViewStore());chat.setMessages([]);chat.clearError();setFallback(false);setRequestFailed(false);}
  useEffect(()=>{
    if(!sourceReady)return;
    const url=new URL(window.location.href),question=url.searchParams.get("question");
    if(question) {setInput(question.slice(0,2000));setTab("coach");url.searchParams.delete("question");window.history.replaceState(window.history.state,"",url);}
    if(url.searchParams.get("goal")==="1") {setGoal(true);url.searchParams.delete("goal");window.history.replaceState(window.history.state,"",url);}
  },[sourceReady]);
  useEffect(()=>{if(tab!=="coach") return;const answer=chat.messages.filter(message=>message.role==="assistant").at(-1);if(!answer || lastScroll.current===answer.id) return;lastScroll.current=answer.id;requestAnimationFrame(()=>document.querySelector(`[data-message-id="${CSS.escape(answer.id)}"]`)?.scrollIntoView({behavior:"instant",block:"start"}));},[chat.messages,tab]);
  useEffect(()=>{if(questionInput.current && focusDraft.current && tab==="coach" && !settings && !goal && !controlsOpen && !busy){questionInput.current.focus({preventScroll:true});focusDraft.current=false;}},[tab,settings,goal,controlsOpen,busy]);
  const askBridge=useRef(ask);askBridge.current=ask;
  const askFromEntry=useCallback((question:string)=>{void askBridge.current(question);},[]);
  const openGoalFromCoach=useCallback(()=>{setGoalOrigin("coach");setSettings(false);setGoal(true);},[setGoalOrigin,setSettings,setGoal]);
  const flat=tab==="overview" && !settings && !goal && !controlsOpen;
  return <div className={`mx-auto min-h-dvh w-full max-w-app navigation-space ${!sourceReady || flat ? "bg-canvas" : "bg-surface"}`}>
    {sourceReady && <header className="pt-safe"><div className="flex min-h-touch items-center justify-between gap-3 px-4"><div className="flex min-w-0 items-center gap-3"><div className="min-w-0"><h1 className="text-xl font-semibold">{t("app")}</h1>{(!flat || embeddedDemo || dataset.startsWith("organizer")) && <p className="mt-1 text-sm text-ink-2">{t(dataset.startsWith("organizer") ? "organizerDate" : "demo",{date:date(snapshot)})}</p>}</div></div>{<Button variant="ghost" size="icon" aria-label={settings || goal || controlsOpen ? t("back") : t("settings")} onClick={()=>{if(controlsOpen){closeControls();}else if(goal){setGoal(false);setSettings(goalOrigin==="settings");}else setSettings(!settings);}}>{settings || goal || controlsOpen ? <ChevronLeft className="size-5"/> : <Settings className="size-5"/>}</Button>}</div></header>}
    <main id="main" tabIndex={-1} className={!sourceReady ? "space-y-6 p-4" : tab==="coach" && !settings && !goal && !controlsOpen ? "px-4 pt-6 conversation-space" : flat ? "px-4" : "space-y-6 px-4 py-6"}>
      {languageStatus && <p role="status" className="mb-4 text-sm text-ink-2">{languageStatus}</p>}
      {!sourceReady ? <><h1 className="text-xl font-semibold">{t("app")}</h1><p role="status">{t(loadError ? "personaError" : "personaLoading")}</p>{loadError ? <DatasetPicker/> : <Skeleton className="h-64 rounded-3xl"/>}</> : <>
      <Tabs value={settings || goal || controlsOpen ? "" : tab} onValueChange={value=>{if(controlsOpen)closeControls();setSettings(false);setGoal(false);setTab(value);}}>
        {controlsOpen ? <MyDataPanel/> : settings ? <PreferencesScreen legal={embeddedDemo} savedGoal={savedGoal} onPrivacyChange={value=>{stop();setPrivacy(value);}} onGoal={()=>{setGoalOrigin("settings");setSettings(false);setGoal(true);}}/> : goal ? <SavingsGoalFlow initial={savedGoal} onBack={()=>{setGoal(false);setSettings(goalOrigin==="settings");}} onSave={value=>{setSavedGoal(value);setGoal(false);setSettings(goalOrigin==="settings");toast.success(t("goalSaved"));}}/> : <>
        <TabsContent value="overview">
          <ViewScope store={visitViews} name="overview"><OverviewFocus onAsk={askFromEntry} onLearn={basket=>{setTab("learn");requestAnimationFrame(()=>document.getElementById(`learn-${basket}`)?.scrollIntoView({block:"start",behavior:"instant"}));}} busy={busy}/></ViewScope>
        </TabsContent>
        <TabsContent value="coach">
          <div className="mb-4 flex items-center justify-between gap-4"><h2 className="text-xl font-semibold">{t("coach")}</h2><Button variant="ghost" size="icon" aria-label={t("clear")} disabled={busy} onClick={clear}><Trash2 className="size-5"/></Button></div>
          {chat.messages.length===0 && <QuestionGrid onAsk={question=>void ask(question)}/>}
          <div aria-live="polite" aria-relevant="additions" aria-busy={busy} className="space-y-8">{chat.messages.map((message,index)=><ConversationEntry key={message.id} message={message} question={chat.messages[index-1]?.role==="user" ? chat.messages[index-1].parts.filter(part=>part.type==="text").map(part=>part.text).join(" ") : ""} store={chatViews} latest={message.id===chat.messages.at(-1)?.id} busy={message.id===chat.messages.at(-1)?.id && busy} onAsk={askFromEntry} onGoal={openGoalFromCoach}/>)}</div>
          {busy && <div role="status" className="space-y-3 py-5"><p className="sr-only">{t("reading")}</p><Skeleton className="h-9 w-40"/><Skeleton className="h-4 w-full"/><Skeleton className="h-4 w-3/4"/><Skeleton className="h-40 w-full rounded-2xl"/><Button variant="outline" size="chip" onClick={stop}>{t("stop")}</Button></div>}
          {fallback && <p role="status" className="py-4 text-caption text-ink-2">{t("fallback")}</p>}
          {requestFailed && <p role="alert" className="py-4 text-sm text-neg">{t("requestFailed")}</p>}
          <div ref={end} className="scroll-above-composer"/>
          <div className="above-navigation pb-safe fixed inset-x-0 z-30 mx-auto w-full max-w-app border-t border-line bg-surface px-4 py-3"><form className="flex flex-wrap items-center gap-2" onSubmit={event=>{event.preventDefault();void ask(input);}}><Input ref={bindQuestionInput} className="min-w-0 flex-1 basis-0" aria-label={t("questionLabel")} placeholder={t("questionLabel")} maxLength={2000} autoComplete="off" value={input} disabled={busy} onChange={e=>{window.dispatchEvent(new Event("money-coach-stop-listening"));setInput(e.target.value);}}/><VoiceInput disabled={busy} onText={text=>{setInput(text);focusDraft.current=true;questionInput.current?.focus({preventScroll:true});}} onSend={askFromEntry}/><Button type="submit" size="icon" aria-label={t("send")} disabled={busy || !input.trim()}><ArrowUp className="size-5"/></Button></form>{!privacy && onlineCoachEnabled && voiceProvider!=="gemini" && <p className="mt-1 text-caption text-ink-2">{t("geminiCoachNotice")}</p>}{!privacy && <p className="mt-1 text-caption text-ink-2">{t(voiceProvider==="gemini" ? onlineCoachEnabled ? "geminiCoachVoiceNotice" : "geminiVoiceNotice" : "speechOnline")}</p>}<p className="mt-2 text-caption text-ink-2">{t("disclaimer")}</p></div>
        </TabsContent>
        <TabsContent value="whatif"><ViewScope store={visitViews} name="simulator"><Simulator goal={savedGoal}/></ViewScope></TabsContent>
        <TabsContent value="learn"><PersonalizedLearn onAsk={askFromEntry}/></TabsContent>
        </>}
        <TabsList aria-label={t("app")} className="pb-safe bottom-keyboard fixed inset-x-0 z-40 mx-auto grid h-auto min-h-navigation w-full max-w-app grid-cols-4 rounded-none border-t border-line bg-surface px-2 py-1">{tabs.map(({key,Icon})=><TabsTrigger key={key} value={key} className="min-h-14 min-w-0 flex-col gap-1 whitespace-normal rounded-xl px-1 py-1 text-caption data-[state=active]:bg-brand-tint data-[state=active]:text-active-ink"><Icon className="size-6"/><span>{t(key)}</span></TabsTrigger>)}</TabsList>
      </Tabs>
      </>}
    </main>{sourceReady && <Toaster/>}
  </div>;
}
function PreferencesScreen({onGoal,savedGoal,onPrivacyChange,legal}:{onGoal:()=>void;savedGoal:SavingsGoal|null;onPrivacyChange:(value:boolean)=>void;legal:boolean}) {
  const {openControls,data,scope}=useMoneyData(),planning=usePlanning(),income=overviewIncome(planning.period,data,planning.income),banks=bankSummaries(data);
  const {locale,uiLanguage,setLocale,savings,setSavings,privacy,voiceProvider,t}=useCopy(),restricted=scope.excludedAccounts.length>0 || scope.excludedCategories.length>0;
  return <div className="space-y-6"><h2 className="text-xl font-semibold">{t("settings")}</h2>
    <SettingsGroup title={t("language")}><RadioGroup aria-label={t("language")} value={uiLanguage} onValueChange={v=>setLocale(v as Locale)} className="gap-0 divide-y divide-line">{(["en","fi","et"] as const).map((value,i)=><label key={value} htmlFor={`language-${value}`} className="flex min-h-14 items-center gap-3 px-4"><RadioGroupItem id={`language-${value}`} value={value}/>{t((["english","finnish","estonian"] as const)[i])}</label>)}</RadioGroup></SettingsGroup>
    <SettingsGroup title={t("settingsDataSource")}><DatasetPicker/><SettingsSheetRow label={t("aboutData")}><DataSourceDetails embedded/></SettingsSheetRow></SettingsGroup>
    <SettingsGroup title={t("coachVisibility")}><SettingsRow label={t(restricted ? "coachSeesLimited" : "coachSeesAll")} onClick={openControls}/></SettingsGroup>
    <SettingsGroup title={t("settingsAiPrivacy")}>
      <label className="flex min-h-14 items-center gap-3 px-4 py-3"><span className="min-w-0 flex-1"><span className="block text-base">{t("privacyMode")}</span><span className="block text-caption text-ink-2">{t("privacyNote")}</span></span><Switch checked={privacy} onCheckedChange={onPrivacyChange} aria-label={t("privacyMode")}/></label>
      <SettingsSheetRow label={t("voiceSettings")} value={t(privacy || voiceProvider!=="gemini" ? "voiceDevice" : "voiceOnline")}><VoiceSettings embedded/></SettingsSheetRow>
    </SettingsGroup>
    <SettingsGroup title={t("settingsBanks")}><SettingsSheetRow label={t("connectedBanks")} value={t(banks.length===1 ? "demoBanksOne" : "demoBanksCount",{count:banks.length})}><ConnectedBanks embedded/></SettingsSheetRow></SettingsGroup>
    <SettingsGroup title={t("settingsPlans")}>
      <SettingsSheetRow label={t("target")} value={percent(savings)}><div className="space-y-3"><p className="text-xl font-semibold tabular-nums">{percent(savings)}{income.amount!==null && <span className="mt-1 block text-sm font-normal text-ink-2">{t("monthlyTargetEffect",{amount:money(basisPointAmount(income.amount,savings*100))})}</span>}</p><Slider aria-label={t("target")} aria-valuetext={percent(savings)} className="min-h-12" min={0} max={100} step={1} value={[savings]} onValueChange={([v])=>setSavings(v)}/><p className="text-sm text-ink-2">{t("targetNote")}</p></div></SettingsSheetRow>
      <SettingsRow label={t(savedGoal ? "editGoal" : "goal")} value={savedGoal ? t("goalSummary",{name:savedGoal.name,amount:money(savedGoal.amountMinor)}) : undefined} onClick={onGoal}/>
      <SettingsSheetRow label={t("monthlyPlans")} value={t("monthlyPlansSummary")}><CategoryLimit/><MonthlyPlans/></SettingsSheetRow>
    </SettingsGroup>
    <SettingsGroup title={t("settingsAbout")} note={t("disclaimer")}>
      <SettingsSheetRow label={t("installTitle")}><InstallApp embedded/></SettingsSheetRow>
      {legal && <SettingsRow label={t("privacyPolicy")} href="/privacy"/>}
      {legal && <SettingsRow label={t("termsOfUse")} href="/terms"/>}
    </SettingsGroup>
  </div>;
}
