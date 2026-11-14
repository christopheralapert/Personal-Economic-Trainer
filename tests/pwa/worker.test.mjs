import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const script = await readFile(new URL("../../apps/web/public/sw.js", import.meta.url), "utf8");
function basic(body="public bytes",headers={},status=200) {
  const response=new Response(body,{status,headers});
  const clone=response.clone.bind(response);
  Object.defineProperty(response,"type",{value:"basic"});
  response.clone=()=>{const copy=clone();Object.defineProperty(copy,"type",{value:"basic"});return copy;};
  return response;
}
function harness({origin="https://moneylens.test",networkDown=false,storageDenied=false,putQuota=false,networkResponse=()=>basic()}={}) {
  const listeners = new Map();
  const stored = new Map([["https://moneylens.test/offline", new Response("public offline page",{headers:{"X-MoneyLens-Public-Bytes":"19"}})]]);
  const writes = [];
  const waits=[],fetches=[];
  const key=request=>typeof request==="string" ? new URL(request,"https://moneylens.test").href : request.url;
  const cache={match:async request=>stored.get(key(request))?.clone(),keys:async()=>[...stored.keys()].map(url=>new Request(url)),
    delete:async request=>stored.delete(key(request)),put:async(request,response)=>{
      if(putQuota) throw Object.assign(new Error("quota"),{name:"QuotaExceededError"});
      writes.push(key(request));stored.set(key(request),response.clone());
    }};
  const scope = {
    URL, Response,Request,Headers,Uint8Array,setTimeout,clearTimeout,
    self: {location: {origin}, addEventListener: (name, handler) => listeners.set(name, handler), skipWaiting() {}},
    caches: {
      open: async () => {if(storageDenied) throw new Error("storage denied");return cache;},
      keys: async () => {if(storageDenied) throw new Error("storage denied");return [];}, delete: async () => true,
    },
    fetch: async (request,options) => {fetches.push({request,options});if(networkDown) throw new Error("offline");return networkResponse();},
  };
  vm.runInNewContext(script, scope);
  return {writes,stored,fetches,async drain(){while(waits.length) await Promise.all(waits.splice(0));},
    async lifecycle(name){listeners.get(name)({waitUntil:value=>waits.push(value)});await this.drain();},
    request(path, {method="GET",mode="cors",headers={}} = {}) {
    let response;
    const request = {url: new URL(path,origin).href, method, mode,headers:new Headers(headers)};
    listeners.get("fetch")({request,respondWith(value){response=value;},waitUntil:value=>waits.push(value)});
    return response;
  }};
}

for (const path of ["/api/v1/dashboard", "/api/v1/accounts/00000000-0000-0000-0000-000000000101/inclusion", "/coach", "/transactions", "/scenarios", "/settings", "/privacy", "/terms", "/analysis", "/banks", "/compare", "/goals", "/insights", "/api/v1/goals", "/api/v1/goals/00000000-0000-0000-0000-000000000000", "/api/v1/insights", "/api/v1/insights/00000000-0000-0000-0000-000000000000", "/api/v1/coaching/preferences", "/api/v1/insights/planning-preview", "/api/v1/insights/spending-preview", "/api/v1/analysis/tools", "/api/v1/analysis/tools/execute", "/api/v2/analysis/tools", "/api/v2/analysis/tools/execute", "/api/v1/analysis/spending/reduction", "/api/v1/benchmarks/comparison", "/api/v1/bank-connections", "/api/v1/live-banking/connections", "/api/v1/live-banking/callback?code=secret&state=secret", "/api/v1/accounts/sources", "/api/demo/profile", "/api/demo/plan", "/v1/plans/safe-amounts", "/auth/callback", "/? _rsc=secret", "/?_rsc=secret", "/_next/static/chunk.js?user=secret", "https://third-party.test/a.js"]) {
  test(`worker never persists private, personalized or unapproved response: ${path}`, async () => {
    const app = harness();
    assert.equal(app.request(path), undefined);
    assert.deepEqual(app.writes, []);
  });
}
test("POST requests never enter the cache or an offline replay queue", () => {
  const app = harness();
  assert.equal(app.request("/api/demo/plan", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/benchmarks/comparison", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/analysis/spending/habits", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v2/analysis/tools/answer", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v2/analysis/tools/answer/card?locale=fi", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/coach/query", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/goals/00000000-0000-0000-0000-000000000000/allocations/00000000-0000-0000-0000-000000000001/link", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/goals/00000000-0000-0000-0000-000000000000/allocations/00000000-0000-0000-0000-000000000001/unlink", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/insights/refresh", {method:"POST"}), undefined);
  assert.equal(app.request("/api/v1/insights/00000000-0000-0000-0000-000000000000/dismiss", {method:"POST"}), undefined);
  assert.equal(app.request("/icons/icon.svg", {method:"POST"}), undefined);
  assert.deepEqual(app.writes, []);
});
test("approved static assets can be cached", async () => {
  const app = harness();
  await app.request("/_next/static/chunks/app-123.js");
  await app.drain();
  assert.deepEqual(app.writes, ["https://moneylens.test/_next/static/chunks/app-123.js"]);
});
test("offline app navigation returns only the public fallback", async () => {
  const app = harness({networkDown:true});
  for (const route of ["/", "/demo", "/demo/basic"]) assert.equal(await (await app.request(route, {mode:"navigate"})).text(), "public offline page");
  // Private navigation is left to the browser; it never receives a cached view.
  assert.equal(app.request("/compare", {mode:"navigate"}), undefined);
  assert.equal(app.request("/insights", {mode:"navigate"}), undefined);
  assert.deepEqual(app.writes, []);
});

test("denied storage and quota errors preserve online delivery and the pinned offline shell",async()=>{
  for(const options of [{storageDenied:true},{putQuota:true}]) {
    const app=harness(options);
    assert.equal(await (await app.request("/_next/static/a.js")).text(),"public bytes");
    await app.drain();assert.deepEqual(app.writes,[]);
    assert(app.stored.has("https://moneylens.test/offline"));
    assert.equal(app.fetches[0].options.credentials,"omit");
    await app.lifecycle("install");await app.lifecycle("activate");
  }
});

test("private varying uncacheable partial and oversized public responses are never stored",async()=>{
  for(const response of [()=>basic("secret",{"Cache-Control":"private"}),()=>basic("secret",{"Cache-Control":"no-store"}),
    ()=>basic("secret",{Vary:"Accept-Encoding, Cookie"}),()=>basic("secret",{Vary:"Authorization"}),()=>basic("secret",{Vary:"*"}),
    ()=>basic("partial",{},206),()=>basic("large",{"Content-Length":String(4*1024**2+1)}),()=>basic("x".repeat(4*1024**2+1))]) {
    const app=harness({networkResponse:response});
    const value=await app.request("/_next/static/a.js");await value.text();await app.drain();assert.deepEqual(app.writes,[]);
  }
  const app=harness();
  assert.equal(app.request("/_next/static/unknown.json"),undefined);
  assert.equal(app.request("/_next/static/a.js",{headers:{Authorization:"Bearer not-for-cache"}}),undefined);
});

test("entry and byte budgets evict oldest runtime entries while retaining pinned public resources",async()=>{
  for(const [entries,size] of [[64,1],[10,4*1024**2]]) {
    const app=harness();
    for(let index=0;index<entries;index++) app.stored.set(`https://moneylens.test/_next/static/old-${index}.js`,
      new Response("authored metadata budget probe",{headers:{"X-MoneyLens-Public-Bytes":String(size)}}));
    await app.request("/_next/static/new.js");await app.drain();
    assert(app.stored.size<=65);
    assert(app.stored.has("https://moneylens.test/offline"));
    assert(!app.stored.has("https://moneylens.test/_next/static/old-0.js"));
    const bytes=[...app.stored.values()].reduce((sum,response)=>sum+Number(response.headers.get("X-MoneyLens-Public-Bytes")),0);
    assert(bytes<=32*1024**2);
  }
});

test("unverified old cache entries are removed and eviction permits a clean network refill",async()=>{
  const app=harness();app.stored.set("https://moneylens.test/_next/static/old.js",new Response("missing size metadata"));
  await app.request("/_next/static/new.js");await app.drain();
  assert(!app.stored.has("https://moneylens.test/_next/static/old.js"));
  app.stored.delete("https://moneylens.test/_next/static/new.js");
  await app.request("/_next/static/new.js");await app.drain();
  assert.equal(app.fetches.length,2);assert.equal(app.writes.length,2);
});

test("a static-response burst admits at most four cache bodies and serializes budget writes",async()=>{
  let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const app=harness({networkResponse:()=>basic(new ReadableStream({async start(controller){await gate;controller.enqueue(new TextEncoder().encode("public"));controller.close();}}))});
  const responses=await Promise.all(Array.from({length:12},(_,index)=>app.request(`/_next/static/burst-${index}.js`)));
  release();await Promise.all(responses.map(response=>response.text()));await app.drain();
  assert.equal(app.fetches.length,12);assert.equal(app.writes.length,4);
});


test("ngrok public assets bypass the warning while keeping all cookies omitted",async()=>{
  const app=harness({origin:"https://trophy-ranged-precook.ngrok-free.dev"});
  await app.request("/_next/static/app.js");await app.drain();
  assert.equal(app.fetches[0].options.credentials,"omit");
  assert.equal(app.fetches[0].options.headers.get("ngrok-skip-browser-warning"),"1");
  assert.equal(app.fetches[0].options.mode,"same-origin");
  const before=app.fetches.length;
  assert.equal(app.request("/api/demo/banks"),undefined);
  assert.equal(app.request("/api/v1/live-banking/institutions"),undefined);
  assert.equal(app.fetches.length,before);
  const normal=harness();await normal.request("/_next/static/app.js");await normal.drain();
  assert.equal(normal.fetches[0].options.headers.has("ngrok-skip-browser-warning"),false);
});

test("HTML warning responses are never stored as assets or served from an old asset cache",async()=>{
  const app=harness({networkResponse:()=>basic("<html>tunnel warning</html>",{"Content-Type":"text/html"})});
  await app.request("/_next/static/app.js");await app.drain();assert.deepEqual(app.writes,[]);
  const old=harness({networkResponse:()=>basic("real script",{"Content-Type":"text/javascript"})});
  old.stored.set("https://moneylens.test/_next/static/app.js",new Response("<html>warning</html>",{headers:{"Content-Type":"text/html","X-MoneyLens-Public-Bytes":"20"}}));
  assert.equal(await (await old.request("/_next/static/app.js")).text(),"real script");
  await old.drain();assert.equal(old.fetches.length,1);
});
