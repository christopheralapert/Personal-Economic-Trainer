export type StateChange<T>=T|((previous:T)=>T);
export const viewStateKey=(scope:string,field:string)=>JSON.stringify([scope,field]);
export const resultViewName=(messageId:string,toolCallId:string)=>JSON.stringify([messageId,toolCallId]);
/** Instantiate per mounted visit; never a module singleton or browser-storage cache. */
export function createViewStore() {
  const values=new Map<string,unknown>(),listeners=new Map<string,Set<()=>void>>();
  function get<T>(key:string,initial:T|(()=>T)):T {
    if(!values.has(key)) values.set(key,typeof initial==="function" ? (initial as ()=>T)() : initial);
    return values.get(key) as T;
  }
  return {get,peek:(key:string)=>values.get(key),
    set<T>(key:string,change:StateChange<T>,initial:T|(()=>T)) {
      const previous=get(key,initial),next=typeof change==="function" ? (change as (value:T)=>T)(previous) : change;
      if(Object.is(previous,next)) return;
      values.set(key,next);for(const listener of [...(listeners.get(key) ?? [])]) listener();
    },
    subscribe(key:string,listener:()=>void) {
      const group=listeners.get(key) ?? new Set();group.add(listener);listeners.set(key,group);
      return ()=>{group.delete(listener);if(!group.size) listeners.delete(key);};
    },
  };
}
export type ViewStore=ReturnType<typeof createViewStore>;
