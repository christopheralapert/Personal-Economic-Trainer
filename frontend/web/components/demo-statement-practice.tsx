"use client";
import {useCallback,useEffect,useState} from 'react';
import {useCopy} from '@/i18n/context';
import {Button} from '@/components/ui/button';
import {StatementImport} from './statement-import';
import {PrivateApiError,type PrivateRequest} from './private-session';
import {demoEntryCopy} from '../i18n/demo-entry';
import {MoneyDataProvider} from '@/lib/money-data-context';
import {PlanningProvider} from '@/lib/planning-context';
import {InstallProvider} from '@/pwa/install-context';
import {MoneyCoach} from '@/components/money-coach';
import {TransactionList} from '@/components/gen/transaction-list';
import {loadTransactions,type Dataset} from '@/engine';
export function DemoStatementPractice(){
 const {locale}=useCopy(),c=demoEntryCopy[locale];
 const [csrf,setCsrf]=useState(''),[error,setError]=useState(false),[view,setView]=useState('import'),[data,setData]=useState<Dataset|null>(null);
 useEffect(()=>{const next=new URLSearchParams(location.search).get('view');if(next==='coach'||next==='transactions')setView(next);},[]);
 const start=useCallback(async()=>{setError(false);try{const response=await fetch('/api/demo-statements/session',{method:'POST',cache:'no-store'});if(!response.ok)throw Error();setCsrf((await response.json()).csrf_token);}catch{setError(true);}},[]);
 useEffect(()=>{void start();},[start]);
 const request=useCallback<PrivateRequest>(async(path,body)=>{
  const response=await fetch('/api/demo-statements/'+path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:body===undefined?undefined:JSON.stringify(body)});
  const value=await response.json();if(!response.ok)throw new PrivateApiError(value.error?.code??'DEMO_UNAVAILABLE',c.expired);return value;
 },[csrf,c.expired]);
 useEffect(()=>{if(view!=='transactions'||!csrf)return;let active=true;void request<unknown>('dataset').then(value=>{if(active)setData(loadTransactions(value));}).catch(()=>{if(active)setError(true);});return()=>{active=false;};},[view,csrf,request]);
 if(view==='coach'&&csrf)return <InstallProvider><MoneyDataProvider defaultDataset="session"><PlanningProvider><MoneyCoach embeddedDemo/></PlanningProvider></MoneyDataProvider></InstallProvider>;
 return <div className="mx-auto min-h-dvh w-full max-w-app bg-canvas px-4 pt-safe"><header className="flex min-h-14 items-center"><a href="/demo" className="text-xl font-semibold text-ink">Money Coach</a></header><main id="main" tabIndex={-1} className="space-y-5 py-6"><a href="/demo" className="text-sm underline underline-offset-4">{c.back}</a><h1 className="text-2xl font-semibold">{view==='transactions'?c.history:c.practice}</h1>{error?<div role="alert" className="space-y-3"><p>{c.failure}</p><Button onClick={()=>void start()}>{c.retry}</Button></div>:!csrf?<p role="status">…</p>:view==='transactions'?data?<><p className="text-sm text-ink-2">{c.scope}</p><MoneyDataProvider defaultDataset="session"><TransactionList rows={data.transactions} openDetails/></MoneyDataProvider><Button asChild className="w-full"><a href={'/demo/import?'+new URLSearchParams({view:'coach',tab:'coach',question:c.question})}>{c.coach}</a></Button></>:<p role="status">…</p>:<><p className="text-sm text-ink-2">{c.practiceNote}</p><Button asChild variant="outline" className="w-full"><a download="auto-taxis.csv" href="/api/demo-statements/sample/auto-taxis.csv">{c.download}</a></Button><p className="text-sm text-ink-2">{c.fileNote}</p><StatementImport request={request} changed={()=>{}} demo/></>}</main></div>;
}
