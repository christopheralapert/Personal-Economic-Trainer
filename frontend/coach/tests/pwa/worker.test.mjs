import {test} from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile} from "node:fs/promises";

const source=await readFile(new URL("../../scripts/worker.js",import.meta.url),"utf8");
const origin="https://coach.example";
function harness(fetcher=async()=>{throw new Error("offline");}) {
  const handlers={};const rows=new Map();let claimed=0;
  const stores=new Map([["money-coach-public-__BUILD__",rows],["money-coach-public-old",new Map([[origin+"/",html("previous installed snapshot")]])],["unrelated-private-cache",new Map()]]);
  function open(name) {
    if(!stores.has(name)) stores.set(name,new Map());
    const entries=stores.get(name);
    return {keys:async()=>[...entries.keys()].map(url=>new Request(url)),match:async request=>entries.get(request.url)?.clone(),put:async(request,response)=>{entries.set(request.url,response.clone());}};
  }
  const cache=open("money-coach-public-__BUILD__");
  const context=vm.createContext({Request,Response,Headers,URL,Uint8Array,Set,Promise,Number,Error,
    fetch:fetcher,caches:{has:async name=>stores.has(name),open:async name=>open(name),keys:async()=>[...stores.keys()],delete:async name=>stores.delete(name)},
    self:{location:{origin},clients:{claim:async()=>{claimed++;}},addEventListener:(name,fn)=>{handlers[name]=fn;}},
  });
  vm.runInContext(source+"\nglobalThis.subject={allowed,reviewed,bounded,put,install,CACHE};",context);
  return {subject:context.subject,handlers,cache,rows,context,stores,claimed:()=>claimed};
}
function html(body="public shell",headers={}) {return new Response(body,{headers:{"content-type":"text/html","cache-control":"public, max-age=0","x-money-coach-public":"synthetic-shell.v1","x-money-coach-revision":"__BUILD__",...headers}});}
const req=path=>new Request(new URL(path,origin));

test("only exact public GET resources can enter the cache; no API, query, RSC or user-bearing requests",()=>{
  const {subject,handlers}=harness();
  assert.equal(subject.allowed(req("/")),true);assert.equal(subject.allowed(req("/_next/static/chunks/abc.js")),true);
  for(const endpoint of ["/api/voice/capabilities","/api/voice/transcribe","/api/voice/speak"]) {
    for(const method of ["GET","POST"]) {
      const request=new Request(origin+endpoint,{method});
      assert.equal(subject.allowed(request),false);
      handlers.fetch({request,respondWith:()=>assert.fail("voice request was intercepted")});
    }
  }
  for(const request of [req("/api/chat"),req("/settings"),req("/?question=taxi"),req("/?_rsc=abc"),new Request(origin+"/",{method:"POST",body:"private"}),new Request(origin+"/",{headers:{rsc:"1"}}),new Request(origin+"/",{headers:{authorization:"Bearer private"}}),new Request("https://other.example/")]) {
    assert.equal(subject.allowed(request),false);
    handlers.fetch({request,respondWith:()=>assert.fail("excluded request was intercepted")});
  }
  assert.equal(subject.reviewed(req("/"),html()),true);
  for(const response of [html("secret",{"cache-control":"private, no-store"}),html("secret",{"x-money-coach-public":""}),html("other build",{"x-money-coach-revision":"different-build"}),html("secret",{vary:"Cookie"}),html("secret",{"set-cookie":"session=private"}),html("RSC",{"content-type":"text/x-component"}),new Response("fail",{status:500})]) assert.equal(subject.reviewed(req("/"),response),false);
});

test("bounded installation rejects partial/oversized boot snapshots and never evicts another app's cache",async()=>{
  const h=harness(async()=>html('<script src="/_next/static/chunks/start.js"></script>'));
  await assert.rejects(h.subject.install()); // The fake JS response is HTML, not executable content.
  assert.equal(h.stores.has(h.subject.CACHE),false);
  assert.equal(await h.stores.get("money-coach-public-old").get(origin+"/").clone().text(),"previous installed snapshot");
  assert.equal(h.stores.has("unrelated-private-cache"),true);
  assert.equal(await h.subject.bounded(new Response(new Uint8Array(3*1024*1024+1))),null);
  const large=()=>new Response(new Uint8Array(3*1024*1024),{headers:{"content-type":"application/javascript","cache-control":"public"}});
  assert.equal(await h.subject.put(h.cache,req("/_next/static/a.js"),large()),true);
  assert.equal(await h.subject.put(h.cache,req("/_next/static/b.js"),large()),true);
  assert.equal(await h.subject.put(h.cache,req("/_next/static/c.js"),large()),false);
  const update=harness();
  let activation;update.handlers.activate({waitUntil:value=>{activation=value;}});await activation;
  assert.equal(update.stores.has("money-coach-public-old"),false);
  assert.equal(update.stores.has(update.subject.CACHE),true);
  assert.equal(update.stores.has("unrelated-private-cache"),true);
  assert.equal(update.claimed(),1);
  const full=harness(async()=>assert.fail("A third snapshot must be rejected before network or cache creation"));
  full.stores.delete(full.subject.CACHE);full.stores.set("money-coach-public-waiting",new Map());
  const retained=[...full.stores.keys()];
  await assert.rejects(full.subject.install(),/Close old app tabs/);
  assert.deepEqual([...full.stores.keys()],retained);
  assert.equal(await full.stores.get("money-coach-public-old").get(origin+"/").clone().text(),"previous installed snapshot");
});

test("offline serves only reviewed installed shell; denied storage leaves network available and no writes are queued",async()=>{
  const h=harness();await h.subject.put(h.cache,req("/"),html());
  let response;h.handlers.fetch({request:req("/"),respondWith:value=>{response=value;}});
  assert.equal(await (await response).text(),"public shell");
  h.context.caches.open=async()=>{throw new Error("storage denied");};
  h.context.fetch=async()=>new Response("online");
  h.handlers.fetch({request:req("/"),respondWith:value=>{response=value;}});
  assert.equal(await (await response).text(),"online");
  h.context.caches.open=async()=>({match:async()=>{throw new Error("lookup denied");}});
  for(const pathname of ["/","/_next/static/chunks/start.js"]) {
    h.handlers.fetch({request:req(pathname),respondWith:value=>{response=value;}});
    assert.equal(await (await response).text(),"online");
  }
  h.context.caches.keys=async()=>{throw new Error("enumeration denied");};
  let activation;h.handlers.activate({waitUntil:value=>{activation=value;}});await activation;assert.equal(h.claimed(),1);
  h.stores.delete(h.subject.CACHE);const remaining=[...h.stores.keys()];
  h.handlers.fetch({request:req("/"),respondWith:value=>{response=value;}});assert.equal(await (await response).text(),"online");
  assert.deepEqual([...h.stores.keys()],remaining);
  assert.equal(h.rows.size,1);
});
