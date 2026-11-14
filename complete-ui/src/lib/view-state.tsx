"use client";
import {createContext,useCallback,useContext,useMemo,useState,useSyncExternalStore,type ReactNode} from "react";
import {createViewStore,viewStateKey,type ViewStore,type StateChange} from "./view-store";

const Context=createContext<{store:ViewStore;name:string}|null>(null);
export function ViewScope({store,name,children}:{store:ViewStore;name:string;children:ReactNode}) {
  const value=useMemo(()=>({store,name}),[store,name]);return <Context value={value}>{children}</Context>;
}
export function useViewState<T>(field:string,initial:T|(()=>T)):[T,(change:StateChange<T>)=>void] {
  const context=useContext(Context),[local]=useState(createViewStore),store=context?.store ?? local;
  const key=viewStateKey(context?.name ?? "local",field);
  const subscribe=useCallback((listener:()=>void)=>store.subscribe(key,listener),[store,key]);
  const snapshot=useCallback(()=>store.get(key,initial),[store,key,initial]);
  const value=useSyncExternalStore(subscribe,snapshot,snapshot);
  const set=useCallback((change:StateChange<T>)=>store.set(key,change,initial),[store,key,initial]);
  return [value,set];
}
