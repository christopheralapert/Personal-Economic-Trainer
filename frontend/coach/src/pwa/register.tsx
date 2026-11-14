"use client";

import {useEffect} from "react";

/** Production-only public demo cache. No prompt, reload, storage or model calls. */
export function RegisterWorker() {
  useEffect(()=>{
    if(process.env.NODE_ENV!=="production" || !window.isSecureContext || !("serviceWorker" in navigator)) return;
    void navigator.serviceWorker.register("/sw.js",{scope:"/",updateViaCache:"none"}).catch(()=>{
      // Unsupported/denied storage must leave the ordinary online app usable.
    });
  },[]);
  return null;
}
