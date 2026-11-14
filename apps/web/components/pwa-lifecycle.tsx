"use client";
import { useEffect, useRef, useState } from "react";

type InstallEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{outcome: string}> };

export function PwaLifecycle() {
  const [offline, setOffline] = useState(false);
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [update, setUpdate] = useState<ServiceWorker | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const reloadOnChange = useRef(false);

  useEffect(() => {
    const online = () => setOffline(!navigator.onLine);
    const offer = (event: Event) => {
      event.preventDefault();
      if (!window.matchMedia("(display-mode: standalone)").matches) setInstall(event as InstallEvent);
    };
    const installed = () => setInstall(null);
    const changed = () => { if (reloadOnChange.current) window.location.reload(); };
    online();
    window.addEventListener("online", online);
    window.addEventListener("offline", online);
    window.addEventListener("beforeinstallprompt", offer);
    window.addEventListener("appinstalled", installed);
    navigator.serviceWorker?.addEventListener("controllerchange", changed);
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js", {scope: "/", updateViaCache: "none"}).then(registration => {
        if (registration.waiting) setUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) setUpdate(worker);
          });
        });
      }).catch(() => { /* Normal online use remains available without worker support. */ });
    }
    return () => {
      window.removeEventListener("online", online); window.removeEventListener("offline", online);
      window.removeEventListener("beforeinstallprompt", offer); window.removeEventListener("appinstalled", installed);
      navigator.serviceWorker?.removeEventListener("controllerchange", changed);
    };
  }, []);

  if (offline) return <aside className="connection-notice" role="status">You’re offline. Financial actions will resume after a fresh connection.</aside>;
  if (update) return <aside className="connection-notice" role="status"><span>An update is ready. Reloading clears unsaved drafts; saved reservations remain available.</span><button onClick={() => {reloadOnChange.current = true; update.postMessage({type: "ACTIVATE_UPDATE"});}}>Update now</button></aside>;
  if (install && !dismissed) return <aside className="connection-notice"><span>Keep Money Coach close. Add it to your home screen.</span><button onClick={async () => { await install.prompt(); await install.userChoice; setInstall(null); }}>Install Money Coach</button><button aria-label="Dismiss install suggestion" onClick={() => setDismissed(true)}>Later</button></aside>;
  return null;
}
