/* Public synthetic demo only. Never reuse this policy for customer data. */
const PREFIX="money-coach-public-";
const VERSION="7ac19d05e487f7b9555a";
const CACHE=PREFIX+VERSION;
const PUBLIC=["/","/kit","/manifest.webmanifest","/icon.svg","/icon-192.png","/icon-512.png","/icon-maskable.png","/apple-touch-icon.png"];
const MAX_ENTRIES=64, MAX_BODY=3*1024*1024, MAX_TOTAL=8*1024*1024, MAX_VERSIONS=2;

function allowed(request) {
  const url=new URL(request.url);
  return request.method==="GET" && url.origin===self.location.origin && !url.search &&
    !request.headers.has("rsc") && !request.headers.has("next-router-state-tree") &&
    !request.headers.has("authorization") && !request.headers.has("range") &&
    (PUBLIC.includes(url.pathname) || /^\/_next\/static\/[\w./-]+\.(?:js|css|woff2?)$/.test(url.pathname));
}
function reviewed(request,response) {
  if(!allowed(request) || response.status!==200 || response.redirected || response.type==="opaque") return false;
  if(response.url && response.url!==request.url) return false;
  const control=response.headers.get("cache-control") ?? "";
  if(!/\bpublic\b/i.test(control) || /\b(?:private|no-store)\b/i.test(control) || response.headers.has("set-cookie") || /cookie|authorization|\*/i.test(response.headers.get("vary") ?? "")) return false;
  const pathname=new URL(request.url).pathname;
  const type=response.headers.get("content-type") ?? "";
  if(PUBLIC.includes(pathname) && response.headers.get("x-money-coach-public")!=="synthetic-shell.v1") return false;
  if(PUBLIC.includes(pathname) && !response.headers.get("x-money-coach-revision")?.startsWith(VERSION)) return false;
  if(pathname==="/" || pathname==="/kit") return type.startsWith("text/html");
  if(pathname.endsWith(".js")) return /(?:javascript|ecmascript)/.test(type);
  if(pathname.endsWith(".css")) return type.startsWith("text/css");
  if(/\.woff2?$/.test(pathname)) return /font|woff/.test(type);
  if(pathname.endsWith(".webmanifest")) return /json|manifest/.test(type);
  return type.startsWith("image/");
}
async function bounded(response) {
  if(Number(response.headers.get("content-length"))>MAX_BODY) return null;
  const reader=response.body?.getReader();if(!reader) return null;
  const chunks=[];let size=0;
  while(true) {
    const {done,value}=await reader.read();if(done) break;
    size+=value.byteLength;
    if(size>MAX_BODY) {await reader.cancel();return null;}
    chunks.push(value);
  }
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const headers=new Headers(response.headers);
  headers.delete("content-encoding");headers.set("content-length",String(size));headers.set("x-coach-cache-bytes",String(size));
  return new Response(bytes,{status:200,headers});
}
async function put(cache,request,response) {
  if(!reviewed(request,response)) return false;
  const safe=await bounded(response);if(!safe) return false;
  const size=Number(safe.headers.get("x-coach-cache-bytes"));
  let total=0,count=0;
  for(const key of await cache.keys()) {
    if(key.url===request.url) continue;
    const old=await cache.match(key);total+=Number(old?.headers.get("x-coach-cache-bytes") ?? MAX_TOTAL);count++;
  }
  // Never evict a pinned boot dependency in order to admit a new asset.
  if(count>=MAX_ENTRIES || total+size>MAX_TOTAL) return false;
  await cache.put(request,safe);return true;
}
async function install() {
  const versions=(await caches.keys()).filter(name=>name.startsWith(PREFIX));
  // Preserve the active and already waiting snapshots. A third release can wait
  // until old tabs close and normal activation removes obsolete caches.
  if(!versions.includes(CACHE) && versions.length>=MAX_VERSIONS) throw new Error("Close old app tabs before installing another public snapshot");
  const cache=await caches.open(CACHE);
  try {
    const assets=new Set(PUBLIC);
    for(const pathname of ["/","/kit"]) {
      const request=new Request(new URL(pathname,self.location.origin),{credentials:"omit",cache:"reload"});
      const response=await fetch(request);
      if(!reviewed(request,response)) throw new Error("Unreviewed public shell");
      const safe=await bounded(response);if(!safe) throw new Error("Public shell exceeds budget");
      const html=await safe.clone().text();
      for(const match of html.matchAll(/(?:src|href)="([^"<>]+)"/g)) {
        const url=new URL(match[1].replaceAll("&amp;","&"),self.location.origin);
        if(url.pathname.startsWith("/_next/static/") && allowed(new Request(url))) assets.add(url.href);
      }
      if(assets.size>MAX_ENTRIES || !(await put(cache,request,safe))) throw new Error("Public cache budget exceeded");
    }
    for(const asset of assets) {
      const request=new Request(new URL(asset,self.location.origin),{credentials:"omit",cache:"reload"});
      if(await cache.match(request)) continue;
      if(!(await put(cache,request,await fetch(request)))) throw new Error("Incomplete public installation");
    }
  } catch(error) {await caches.delete(CACHE).catch(()=>false);throw error;}
}
self.addEventListener("install",event=>event.waitUntil(install()));
// Default waiting lifecycle preserves an open, memory-only conversation on updates.
self.addEventListener("activate",event=>event.waitUntil((async()=>{
  try {
    for(const key of await caches.keys()) if(key.startsWith(PREFIX) && key!==CACHE) await caches.delete(key).catch(()=>false);
  } catch { /* Storage denial must not block activation and ordinary online use. */ }
  await self.clients.claim();
})()));
async function lookup(cache,request) {
  try {return await cache.match(request);} catch {return undefined;}
}
self.addEventListener("fetch",event=>{
  if(!allowed(event.request)) return;
  const request=event.request;
  const task=(async()=>{
    let cache;
    try {
      if(!(await caches.has(CACHE))) return fetch(request);
      cache=await caches.open(CACHE);
    } catch {return fetch(request);}
    const asset=new URL(request.url).pathname.startsWith("/_next/static/");
    try {
      if(asset) {const hit=await lookup(cache,request);if(hit) return hit;}
      // Only installation writes the complete, bounded boot snapshot. Mixing
      // fresh HTML into an older snapshot could strand it without its chunks.
      return await fetch(request);
    } catch(error) {
      const hit=await lookup(cache,request);if(hit) return hit;
      throw error;
    }
  })();
  event.respondWith(task);
});
