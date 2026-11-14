"use client";
import {useEffect} from "react";

export function SkipToContent() {
  useEffect(()=>{
    let target=document.getElementById("main"),ownsFocus=target!==null && document.activeElement===target;
    const rememberFocus=(event:FocusEvent)=>{
      ownsFocus=event.target instanceof HTMLElement && event.target.id==="main";
      if(ownsFocus)target=event.target as HTMLElement;
    };
    const pointer=(event:PointerEvent)=>{if(event.target instanceof Node && !target?.contains(event.target))ownsFocus=false;};
    const blur=()=>{ownsFocus=false;};
    // Dataset planning can remount the demo. Restore only focus lost with the
    // old landmark, never a subsequent keyboard, pointer, or window-focus choice.
    const observer=new MutationObserver(()=>{
      if(!ownsFocus || !target || target.isConnected)return;
      const replacement=document.getElementById("main");
      if(replacement && document.activeElement===document.body){target=replacement;target.focus({preventScroll:true});}
    });
    document.addEventListener("focusin",rememberFocus);
    document.addEventListener("pointerdown",pointer);
    window.addEventListener("blur",blur);
    observer.observe(document.body,{childList:true,subtree:true});
    return ()=>{observer.disconnect();document.removeEventListener("focusin",rememberFocus);document.removeEventListener("pointerdown",pointer);window.removeEventListener("blur",blur);};
  },[]);
  return <a className="skip-link" href="#main">Skip to content</a>;
}
