"use client";
import {useEffect} from "react";

/** Follow a keyboard's visible viewport without disabling or following pinch zoom. */
export function useKeyboardViewport(active:boolean) {
  useEffect(()=>{
    const viewport=window.visualViewport;
    if(!active || !viewport) return;
    const root=document.documentElement;
    let frame=0,raised=false;
    function measure() {
      frame=0;
      const node=document.activeElement;
      const editing=node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || (node instanceof HTMLElement && node.isContentEditable);
      // Keep the dock raised during the blur/keyboard-close animation as well.
      const inset=(editing || raised) && viewport!.scale===1 ? Math.max(0,window.innerHeight-viewport!.height-viewport!.offsetTop) : 0;
      raised=inset>0;
      // This is a measured browser coordinate, not a component design dimension.
      root.style.setProperty("--keyboard-inset",`${inset}px`);
    }
    function schedule() {if(!frame) frame=requestAnimationFrame(measure);}
    viewport.addEventListener("resize",schedule);viewport.addEventListener("scroll",schedule);
    window.addEventListener("resize",schedule);document.addEventListener("focusin",schedule);document.addEventListener("focusout",schedule);
    schedule();
    return ()=>{
      cancelAnimationFrame(frame);viewport.removeEventListener("resize",schedule);viewport.removeEventListener("scroll",schedule);
      window.removeEventListener("resize",schedule);document.removeEventListener("focusin",schedule);document.removeEventListener("focusout",schedule);
      root.style.removeProperty("--keyboard-inset");
    };
  },[active]);
}
