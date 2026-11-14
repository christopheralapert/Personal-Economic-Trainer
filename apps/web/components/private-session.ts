"use client";

import {useCallback, useEffect, useRef, useState} from "react";
import {flushSync} from "react-dom";
import type {components} from "@contracts";

export type Session = components["schemas"]["SessionView"];
type Phase = "checking" | "signed-out" | "ready" | "paused" | "offline";
export class PrivateApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
export function aborted(reason: unknown) { return reason instanceof DOMException && reason.name === "AbortError"; }

async function decode<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let error: {code?: string; message?: string} = {};
    try { error = (await response.json()).error ?? {}; } catch { /* Fixed recovery text below. */ }
    throw new PrivateApiError(error.code ?? "SERVICE_UNAVAILABLE",
      error.message && error.message.length <= 300 ? error.message : "The request could not be completed. Check your connection and try again.");
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function usePrivateSession() {
  const [phase, setPhase] = useState<Phase>("checking");
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState("");
  const live = useRef<Session | null>(null);
  const generation = useRef(0);
  const pending = useRef(new Set<AbortController>());
  const channel = useRef<BroadcastChannel | null>(null);
  const checking = useRef(false);

  const clear = useCallback((next: Phase) => {
    generation.current += 1;
    for (const controller of pending.current) controller.abort();
    pending.current.clear();
    checking.current = false;
    live.current = null;
    setSession(null); setPhase(next);
    return generation.current;
  }, []);

  const announce = useCallback(() => { channel.current?.postMessage({type: "invalidate"}); window.dispatchEvent(new Event("moneylens-data-changed")); }, []);
  const verify = useCallback(async (quiet = false) => {
    if (document.visibilityState === "hidden") { clear("paused"); return; }
    if (!navigator.onLine) { clear("offline"); return; }
    if (quiet && checking.current) return;
    const epoch = quiet ? generation.current : clear("checking");
    checking.current = true;
    const controller = new AbortController(); pending.current.add(controller);
    try {
      const next = await decode<Session>(await fetch("/api/v1/auth/session", {cache: "no-store", signal: controller.signal}));
      if (epoch !== generation.current || controller.signal.aborted) return;
      const old = live.current;
      if (old && (old.session_id !== next.session_id || old.permission_version !== next.permission_version || old.synthetic !== next.synthetic ||
        old.owner.user_id !== next.owner.user_id || old.owner.tenant_id !== next.owner.tenant_id)) clear("checking");
      live.current = next; setSession(next); setPhase("ready"); setError("");
    } catch (reason) {
      if (aborted(reason) || epoch !== generation.current) return;
      clear("signed-out");
      if (!(reason instanceof PrivateApiError && reason.code === "UNAUTHENTICATED"))
        setError(reason instanceof Error ? reason.message : "Your session could not be checked. Try again when connected.");
    } finally {
      pending.current.delete(controller);
      if (epoch === generation.current) checking.current = false;
    }
  }, [clear]);

  const request = useCallback(async <T,>(path: string, body?: object, options?: {timeoutMs:number}): Promise<T> => {
    const owner = live.current, epoch = generation.current;
    if (!owner || !navigator.onLine || document.visibilityState === "hidden") throw new DOMException("Private view is inactive", "AbortError");
    const controller = new AbortController(); pending.current.add(controller);
    let timedOut=false;
    const timer=options?setTimeout(()=>{timedOut=true;controller.abort();},options.timeoutMs):undefined;
    try {
      const headers: Record<string,string> = {"X-MoneyLens-Session-ID": owner.session_id};
      if (body !== undefined) { headers["Content-Type"] = "application/json"; headers["X-CSRF-Token"] = owner.csrf_token; }
      const response = await fetch(`/api/v1/${path}`, {cache: "no-store", signal: controller.signal,
        method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body)});
      const value = await decode<T>(response);
      if (epoch !== generation.current || live.current?.session_id !== owner.session_id || controller.signal.aborted)
        throw new DOMException("The private view changed", "AbortError");
      return value;
    } catch (reason) {
      if (epoch !== generation.current || live.current?.session_id !== owner.session_id) throw new DOMException("The private view changed", "AbortError");
      if (timedOut) throw new PrivateApiError("REQUEST_TIMED_OUT","The request took too long. Try again.");
      if (controller.signal.aborted) throw new DOMException("The private view changed", "AbortError");
      if (reason instanceof PrivateApiError && ["UNAUTHENTICATED", "SESSION_CHANGED"].includes(reason.code)) void verify();
      throw reason;
    } finally { clearTimeout(timer); pending.current.delete(controller); }
  }, [verify]);

  const transfer = useCallback(async (link: {url:string;headers:Record<string,string>;size_bytes:number}, file:File, scopeSignal?:AbortSignal) => {
    const owner=live.current,epoch=generation.current;
    if (!owner || !owner.synthetic || !navigator.onLine || document.visibilityState==="hidden") throw new DOMException("Private view is inactive","AbortError");
    const target=new URL(link.url);
    const loopback=(host:string)=>["localhost","127.0.0.1"].includes(host);
    const names=Object.keys(link.headers).map(name=>name.toLowerCase());
    const headers=new Headers(link.headers);
    if ((target.protocol!=="https:" && !(target.protocol==="http:" && loopback(target.hostname) && loopback(location.hostname))) ||
        target.username || target.password || names.length!==3 || new Set(names).size!==3 ||
        !names.every(name=>["content-type","if-none-match","x-amz-checksum-sha256"].includes(name)) ||
        headers.get("content-type")!=="text/csv" || headers.get("if-none-match")!=="*" ||
        !/^[A-Za-z0-9+/]{43}=$/.test(headers.get("x-amz-checksum-sha256") ?? "") || link.size_bytes!==file.size)
      throw new PrivateApiError("IMPORT_UPLOAD_UNAVAILABLE","The private upload could not be prepared. Reload its status before retrying.");
    const controller=new AbortController();pending.current.add(controller);
    const cancel=()=>controller.abort();
    scopeSignal?.addEventListener("abort",cancel,{once:true});
    if (scopeSignal?.aborted) controller.abort();
    try {
      // A File body is sent directly; CSV bytes never enter a whole-file ArrayBuffer.
      // Signed storage capabilities get neither session cookies nor a referrer.
      const response=await fetch(target,{method:"PUT",headers,body:file,signal:controller.signal,
        credentials:"omit",cache:"no-store",redirect:"error",referrerPolicy:"no-referrer"});
      if (epoch!==generation.current || live.current?.session_id!==owner.session_id || controller.signal.aborted)
        throw new DOMException("The private view changed","AbortError");
      if (response.ok) return "sent" as const;
      if (response.status===412) return "present" as const; // byte verification, not this response, decides integrity
      throw new PrivateApiError("IMPORT_UPLOAD_UNCONFIRMED","This file upload could not be confirmed. Retry the original files or check the source status.");
    } catch (reason) {
      if (epoch!==generation.current || controller.signal.aborted || aborted(reason)) throw new DOMException("The private view changed","AbortError");
      if (reason instanceof PrivateApiError) throw reason;
      throw new PrivateApiError("IMPORT_UPLOAD_UNCONFIRMED","This file upload could not be confirmed. Retry the original files or check the source status.");
    } finally {pending.current.delete(controller);scopeSignal?.removeEventListener("abort",cancel);}
  },[]);

  const signIn = useCallback(async (profile: "aino" | "mika") => {
    const epoch = clear("checking"); setError("");
    const controller = new AbortController(); pending.current.add(controller);
    announce();
    try {
      await decode<Session>(await fetch("/api/v1/auth/demo", {method: "POST", cache: "no-store", signal: controller.signal,
        headers: {"Content-Type": "application/json"}, body: JSON.stringify({profile})}));
      announce();
      if (epoch === generation.current) void verify();
    } catch (reason) {
      if (!aborted(reason) && epoch === generation.current) {
        clear("signed-out"); setError(reason instanceof Error ? reason.message : "Sign-in failed. Please try again.");
      }
    } finally { pending.current.delete(controller); announce(); }
  }, [announce, clear, verify]);

  const signOut = useCallback(async () => {
    const owner = live.current;
    const epoch = clear("checking"); setError(""); announce();
    if (!owner) { setPhase("signed-out"); return; }
    const controller = new AbortController(); pending.current.add(controller);
    try {
      await decode<void>(await fetch("/api/v1/auth/logout", {method: "POST", cache: "no-store", signal: controller.signal,
        headers: {"X-CSRF-Token": owner.csrf_token, "X-MoneyLens-Session-ID": owner.session_id}}));
      if (epoch === generation.current) setPhase("signed-out");
    } catch (reason) {
      if (!aborted(reason) && epoch === generation.current) {
        setPhase("signed-out"); setError("Sign-out could not be confirmed. Reconnect, reload and sign out again.");
      }
    } finally { pending.current.delete(controller); announce(); }
  }, [announce, clear]);

  useEffect(() => {
    if ("BroadcastChannel" in window) {
      channel.current = new BroadcastChannel("moneylens-private-lifecycle-v1");
      channel.current.onmessage = event => { if (event.data?.type === "invalidate") void verify(); };
    }
    void verify();
    // Native lifecycle handlers must remove private DOM before returning: a
    // queued React update could otherwise miss a page-freeze/BFCache snapshot.
    const visibility = () => { if (document.visibilityState === "hidden") flushSync(() => clear("paused")); else void verify(); };
    const offline = () => flushSync(() => clear("offline"));
    const online = () => void verify();
    const pagehide = () => flushSync(() => clear("paused"));
    const pageshow = (event: PageTransitionEvent) => { if (event.persisted) void verify(); };
    const interval = window.setInterval(() => { if (live.current && document.visibilityState === "visible") void verify(true); }, 15000);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", offline); window.addEventListener("online", online);
    window.addEventListener("pagehide", pagehide); window.addEventListener("pageshow", pageshow);
    return () => {
      generation.current += 1;
      for (const controller of pending.current) controller.abort();
      pending.current.clear(); live.current = null;
      channel.current?.close(); channel.current = null;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", offline); window.removeEventListener("online", online);
      window.removeEventListener("pagehide", pagehide); window.removeEventListener("pageshow", pageshow);
    };
  }, [clear, verify]);
  return {phase, session, error, request, transfer, signIn, signOut, refresh: verify, announce};
}

export type PrivateRequest = ReturnType<typeof usePrivateSession>["request"];
export type PrivateTransfer = ReturnType<typeof usePrivateSession>["transfer"];
