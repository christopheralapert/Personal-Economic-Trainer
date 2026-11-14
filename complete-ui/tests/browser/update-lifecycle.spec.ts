import {test,expect,type Page} from "@playwright/test";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import type {AddressInfo} from "node:net";
import path from "node:path";

// Real production worker, with tiny public boot fixtures so two immutable
// releases can coexist without rebuilding or changing the running phone demo.
const versions=["a".repeat(20),"b".repeat(20),"c".repeat(20)];
async function update(page:Page) {
  return page.evaluate(async()=>{
    const registration=await navigator.serviceWorker.getRegistration();
    if(!registration) throw new Error("Missing worker registration");
    return new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>{cleanup();reject(new Error("Worker update timed out"));},15000);
      let worker:ServiceWorker|null=null;
      function cleanup(){clearTimeout(timer);registration!.removeEventListener("updatefound",found);worker?.removeEventListener("statechange",changed);}
      function changed(){if(worker && ["installed","redundant"].includes(worker.state)){const state=worker.state;cleanup();resolve(state);}}
      function found(){worker=registration!.installing;worker?.addEventListener("statechange",changed);changed();}
      registration.addEventListener("updatefound",found);
      void registration.update().catch(error=>{cleanup();reject(error);});
    });
  });
}
async function cacheNames(page:Page) {return page.evaluate(async()=>(await caches.keys()).sort());}

test("real worker waits for every old tab, keeps offline snapshots and rejects a third release",async({context})=>{
  test.setTimeout(60000);
  const template=await readFile(path.resolve(__dirname,"../../scripts/worker.js"),"utf8");
  let release=versions[0];
  const server=createServer((request,response)=>{
    const pathname=new URL(request.url!,"http://localhost").pathname;
    response.setHeader("cache-control","public, max-age=0");
    response.setHeader("x-money-coach-public","synthetic-shell.v1");
    response.setHeader("x-money-coach-revision",release);
    if(pathname==="/sw.js") {response.setHeader("content-type","application/javascript");response.end(template.replace("__BUILD__",release));}
    else if(pathname==="/" || pathname==="/kit") {
      response.setHeader("content-type","text/html");
      response.end(`<!doctype html><html lang="en"><title>Public worker lifecycle fixture</title><body><h1>${release}</h1><input aria-label="Memory-only draft"><script src="/_next/static/${release}.js"></script></body></html>`);
    } else if(versions.some(version=>pathname===`/_next/static/${version}.js`)) {
      response.setHeader("content-type","application/javascript");
      response.end(`globalThis.bootRevision=${JSON.stringify(pathname.split("/").pop()!.slice(0,-3))};`);
    } else if(pathname==="/manifest.webmanifest") {response.setHeader("content-type","application/manifest+json");response.end("{}");}
    else if(["/icon.svg","/icon-192.png","/icon-512.png","/icon-maskable.png","/apple-touch-icon.png"].includes(pathname)) {
      response.setHeader("content-type","image/svg+xml");response.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
    } else {response.statusCode=404;response.end();}
  });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const first=await context.newPage();await first.goto(origin);
    await first.evaluate(async()=>{
      await navigator.serviceWorker.register("/sw.js",{updateViaCache:"none"});
      await navigator.serviceWorker.ready;
      if(!navigator.serviceWorker.controller) await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener("controllerchange",()=>resolve(),{once:true}));
      await caches.open("unrelated-cache");
    });
    const second=await context.newPage();await second.goto(origin);
    await first.getByRole("textbox").fill("First window draft");
    await second.getByRole("textbox").fill("Second window draft");
    release=versions[1];expect(await update(first)).toBe("installed");
    await expect.poll(()=>first.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(true);
    await expect(first.getByRole("textbox")).toHaveValue("First window draft");
    await expect(second.getByRole("textbox")).toHaveValue("Second window draft");
    const twoCaches=[...versions.slice(0,2).map(v=>`money-coach-public-${v}`),"unrelated-cache"].sort();
    expect(await cacheNames(first)).toEqual(twoCaches);

    // Capacity rejection must preserve both the active and already waiting release.
    release=versions[2];expect(await update(first)).toBe("redundant");
    expect(await cacheNames(first)).toEqual(twoCaches);
    expect(await first.evaluate(async()=>(await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
    release=versions[1];
    await context.setOffline(true);
    await second.reload();
    await expect(second.getByRole("heading")).toHaveText(versions[0]);
    expect(await second.evaluate(()=>(globalThis as unknown as {bootRevision:string}).bootRevision)).toBe(versions[0]);
    await expect(first.getByRole("textbox")).toHaveValue("First window draft");
    await first.close();
    // One remaining old client still prevents activation.
    expect(await second.evaluate(async()=>(await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe("installed");
    await second.close();

    const current=await context.newPage();await current.goto(origin);
    await expect(current.getByRole("heading")).toHaveText(versions[1]);
    expect(await current.evaluate(()=>(globalThis as unknown as {bootRevision:string}).bootRevision)).toBe(versions[1]);
    await expect.poll(()=>cacheNames(current)).toEqual([`money-coach-public-${versions[1]}`,"unrelated-cache"].sort());
    await expect(current.getByRole("textbox")).toHaveValue("");
    await context.setOffline(false);
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>server.close(error=>error ? reject(error) : resolve()));
  }
});
