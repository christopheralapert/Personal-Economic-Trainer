"use client";
import {createContext,useContext,useMemo,useState,useEffect,useRef,type ReactNode} from "react";
import {loadDataset,datasetKeySchema,type DatasetKey} from "@/engine/datasets";
import {demo,type Basket,type Dataset} from "@/engine";
import {classificationQueue,scopedDataset,dataScopeSchema,emptyScope,type DataScope} from "@/engine/data-scope";
const key="money-coach-data-scope.v1";
type State={ready:boolean;loadError:boolean;dataset:DatasetKey;source:Dataset;selectDataset:(key:DatasetKey)=>void;controlsOpen:boolean;openControls:()=>void;closeControls:()=>void;data:Dataset;scope:DataScope;signature:string;setScope:(scope:DataScope)=>void;correct:(id:string,basket:Basket,category?:string)=>void;queue:ReturnType<typeof classificationQueue>;reset:()=>void};
const Context=createContext<State>({ready:true,loadError:false,dataset:"starter",source:demo,selectDataset:()=>{},controlsOpen:false,openControls:()=>{},closeControls:()=>{},data:demo,scope:emptyScope,signature:JSON.stringify(emptyScope),setScope:()=>{},correct:()=>{},queue:classificationQueue(demo),reset:()=>{}});
export function MoneyDataProvider({children,defaultDataset="starter"}:{children:ReactNode;defaultDataset?:DatasetKey}) {
 const [dataset,setDataset]=useState<DatasetKey>(defaultDataset),[source,setSource]=useState<Dataset>(demo),[loadError,setLoadError]=useState(false),generation=useRef(0),storageKey=dataset==="starter" ? key : key+"."+dataset;
 const [controlsOpen,setControlsOpen]=useState(false);
 const [scope,update]=useState<DataScope>(emptyScope),[ready,setReady]=useState(false),data=useMemo(()=>scopedDataset(source,scope),[source,scope]);
 useEffect(()=>{
  const requests=generation;let selected=defaultDataset;
  try{const url=new URL(window.location.href),requested=url.searchParams.get("dataset"),parsed=datasetKeySchema.safeParse(defaultDataset==='session'?'session':requested??localStorage.getItem("money-coach-dataset.v1")??defaultDataset);selected=parsed.success&&parsed.data!=='session' ? parsed.data : defaultDataset;}catch{}
  void selectDataset(selected,false);
  return ()=>{requests.current++;};
 // Selection loads atomically; stale imports may not replace a newer choice.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[defaultDataset]);
 useEffect(()=>{if(ready)try{localStorage.setItem(storageKey,JSON.stringify(scope));}catch{}},[scope,ready,storageKey]);
 function clearThreads(){try{for(const stored of Object.keys(sessionStorage))if(stored.startsWith("money-coach-thread."))sessionStorage.removeItem(stored);}catch{}}
 function setScope(next:DataScope){const checked=dataScopeSchema.parse(next);scopedDataset(source,checked);update(checked);try{localStorage.setItem(storageKey,JSON.stringify(checked));}catch{}clearThreads();}
 async function selectDataset(next:DatasetKey,clear=true){
  const checked=datasetKeySchema.parse(next),turn=++generation.current;setReady(false);setLoadError(false);
  try{
   const loaded=await loadDataset(checked);if(turn!==generation.current)return;
   let saved=emptyScope;
   try{const raw=localStorage.getItem(checked==="starter" ? key : key+"."+checked);if(raw && raw.length<=65536){const parsed=dataScopeSchema.parse(JSON.parse(raw));scopedDataset(loaded,parsed);saved=parsed;}}catch{}
   if(clear)clearThreads();update(saved);setSource(loaded);setDataset(checked);
   try{if(checked!=='session')localStorage.setItem("money-coach-dataset.v1",checked);const url=new URL(window.location.href);if(checked!=='session'&&url.pathname==='/demo'){url.searchParams.set("dataset",checked);window.history.replaceState(window.history.state,"",url);}}catch{}
   setReady(true);
  }catch{if(turn===generation.current)setLoadError(true);}
 }

 return <Context value={{ready,loadError,dataset,source,selectDataset,controlsOpen,openControls:()=>setControlsOpen(true),closeControls:()=>setControlsOpen(false),data,scope,signature:dataset==="starter" ? JSON.stringify(scope) : `${dataset}/${dataset==='session'?source.accounts.map(a=>a.id).join(',')+'/':''}${JSON.stringify(scope)}`,setScope,correct:(id,basket,category)=>setScope({...scope,corrections:{...scope.corrections,[id]:{basket,...(category ? {category} : {})}}}),queue:classificationQueue(data,scope.corrections),reset:()=>setScope(emptyScope)}}>{children}</Context>;
}
export function useMoneyData(){return useContext(Context);}
