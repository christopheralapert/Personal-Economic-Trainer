"use client";

import {useEffect,useRef,useState} from "react";
import type {components} from "@contracts";
import {aborted,type PrivateRequest} from "./private-session";

type Explanation=components["schemas"]["EducationExplanationV1"];
type Locale=Explanation["locale"];
const initialTopics=[
  ["observed_spending","Observed spending"],["spending_baskets","Three spending baskets"],
  ["cash_flow","Cash flow"],["protected_money","Money kept for a purpose"],
  ["shared_surplus","Spending and saving"],["opportunity_cost","What a choice leaves out"],
  ["scenario_assumptions","What-if assumptions"],["population_mean","Population averages"],
].map(([id,title])=>({id,title}));
const text={en:{more:"A little more detail",choice:"Something to consider"},
  fi:{more:"Hieman tarkemmin",choice:"Pohdittavaa"},sv:{more:"Lite mer i detalj",choice:"Något att fundera på"}};

function ExplanationBody({request,initialTopic}:{request:PrivateRequest;initialTopic:string}) {
  const [topic,setTopic]=useState(initialTopic),[locale,setLocale]=useState<Locale>("en");
  const [card,setCard]=useState<Explanation|null>(null);
  const [topics,setTopics]=useState(initialTopics),[error,setError]=useState("");
  const [loading,setLoading]=useState(false),[retry,setRetry]=useState(0);
  const epoch=useRef(0);
  useEffect(()=>{
    const generation=++epoch.current;setCard(null);setError("");setLoading(true);
    void request<Explanation>(`public/education?topic=${encodeURIComponent(topic)}&locale=${locale}`).then(value=>{
      if (generation!==epoch.current) return;
      if (value.topic!==topic || value.locale!==locale) throw new Error("The learning-note scope changed");
      setCard(value);setTopics(value.topics);
    }).catch(reason=>{
      if (generation===epoch.current && !aborted(reason)) setError("The learning notes could not be loaded. Your financial view is still available.");
    }).finally(()=>{if (generation===epoch.current) setLoading(false);});
    return()=>{epoch.current++;};
  },[request,topic,locale,retry]);
  const chooseTopic=(value:string)=>{epoch.current++;setCard(null);setError("");setTopic(value);};
  const chooseLocale=(value:Locale)=>{epoch.current++;setCard(null);setError("");setLocale(value);setTopics(initialTopics);};
  return <div className="education-body">
    <div className="plan-fields">
      <label className="plan-field">Money topic<select aria-label="Money topic" value={topic} onChange={event=>chooseTopic(event.target.value)}>
        {topics.map(item=><option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label className="plan-field">Explanation language<select aria-label="Explanation language" value={locale} onChange={event=>chooseLocale(event.target.value as Locale)}>
        <option value="en" lang="en">English</option><option value="fi" lang="fi">Suomi</option><option value="sv" lang="sv">Svenska</option>
      </select></label>
    </div>
    {loading && <p role="status" className="field-hint">Loading the explanation…</p>}
    {error && <div className="error-notice" role="alert"><span>{error}</span><button className="text-button" onClick={()=>setRetry(value=>value+1)}>Try learning notes again</button></div>}
    {card && <article className="education-copy" lang={card.locale} aria-live="polite">
      <h3>{card.title}</h3><p>{card.summary}</p>
      <details key={`${card.topic}:${card.locale}`}><summary>{text[card.locale].more}</summary>
        {card.details.map((detail,index)=><p key={index}>{detail}</p>)}
        <p><strong>{text[card.locale].choice}:</strong> {card.practical_choice}</p>
      </details>
    </article>}
  </div>;
}

export function EducationHelp({request,initialTopic}:{request:PrivateRequest;initialTopic:string}) {
  const [open,setOpen]=useState(false);
  return <details className="panel education-help" onToggle={event=>setOpen(event.currentTarget.open)}>
    <summary>Understand the money concepts</summary>
    {open && <ExplanationBody request={request} initialTopic={initialTopic}/>}
  </details>;
}
