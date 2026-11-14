import {afterEach,describe,expect,it,vi} from "vitest";
import {DefaultChatTransport} from "ai";
import {BODY_TIMEOUT_MS,MAX_REQUEST_BYTES,readCoachJSON} from "./request";
import {RuleProvider} from "./rule-provider";
import {POST} from "@/app/api/chat/route";
import {createChatRoute} from "./chat-route";
import {coachFetch,prepareCoachRequest,COACH_REVISION,REVISION_HEADER} from "./transport";
import type {CoachMessage} from "./catalog";

const url="http://localhost/api/chat";
function request(body:BodyInit,headers:HeadersInit={"content-type":"application/json"},signal?:AbortSignal) {
  const reviewed=new Headers(headers);if(!reviewed.has(REVISION_HEADER)) reviewed.set(REVISION_HEADER,COACH_REVISION);
  return new Request(url,{method:"POST",body,headers:reviewed,signal,...(body instanceof ReadableStream ? {duplex:"half"} : {})});
}
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});

describe("bounded public chat ingress",()=>{
  it("returns a private, revisioned failure when execution unexpectedly rejects",async()=>{
    const execute=vi.fn().mockRejectedValue(new Error("private execution details"));
    const response=await createChatRoute(execute)(request(JSON.stringify({messages:[{role:"user",parts:[{type:"text",text:"How much did I spend on taxis last month?"}]}]})));
    expect(response.status).toBe(503);expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get(REVISION_HEADER)).toBe(COACH_REVISION);expect(await response.text()).toBe("");
  });

  it("treats a rejection after client cancellation as cancellation",async()=>{
    const controller=new AbortController();
    const execute=vi.fn().mockImplementation(async()=>{controller.abort();throw new Error("disconnected");});
    const response=await createChatRoute(execute)(request(JSON.stringify({messages:[{role:"user",parts:[{type:"text",text:"How much did I spend on taxis last month?"}]}]}),{"content-type":"application/json"},controller.signal));
    expect(response.status).toBe(400);expect(await response.text()).toBe("");
  });

  it("accepts selector-only follow-ups and rejects injected financial context",async()=>{
    const context={tool:"showWhatIf",input:{period:{start:"2026-10-01",end:"2026-11-01"},category:"dining",pct:20}};
    const payload={context,messages:[{role:"user",parts:[{type:"text",text:"And at 30%?"}]}]};
    const response=await POST(request(JSON.stringify(payload)));
    expect(response.status).toBe(200);expect(await response.text()).toContain('"monthly":7500');
    expect((await POST(request(JSON.stringify({...payload,context:{...context,input:{...context.input,balance:999999}}})))).status).toBe(400);
    const without=await POST(request(JSON.stringify({messages:payload.messages})));
    expect(await without.text()).not.toContain("tool-output-available");
  });

  it("rejects unsupported/oversized/malformed payloads before provider dispatch and releases the byte reader",async()=>{
    const dispatch=vi.spyOn(RuleProvider.prototype,"answer");
    for(const [req,status] of [
      [new Request(url,{method:"POST",body:"{}",headers:{"content-type":"application/json"}}),409],
      [request("{}",{"content-type":"application/json",[REVISION_HEADER]:"old-snapshot"}),409],
      [request("{}",{"content-type":"text/plain"}),415],
      [request("{}",{"content-type":"application/json","content-encoding":"gzip"}),415],
      [request("{}",{"content-type":"application/json","content-length":String(MAX_REQUEST_BYTES+1)}),413],
      [request(new Uint8Array([0xff])),400],
      [request("{"),400],
      [request(JSON.stringify({messages:[{role:"user",parts:[{type:"text",text:"taxi spend last month"},{type:"file",mediaType:"text/plain",url:"ignored-scope"}]}]})),400],
      [request(JSON.stringify({messages:[{role:"assistant",parts:[{type:"text",text:"taxi spend last month"}]}]})),400],
    ] as const) {
      const response=await POST(req);expect(response.status).toBe(status);expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    let canceled=false;
    const stream=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(MAX_REQUEST_BYTES));controller.enqueue(new Uint8Array(1));},cancel(){canceled=true;}});
    const input=request(stream);expect((await POST(input)).status).toBe(413);expect(canceled).toBe(true);expect(input.body?.locked).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("bounds stalled reads and client cancellation even when stream cancellation never resolves",async()=>{
    vi.useFakeTimers();
    const dispatch=vi.spyOn(RuleProvider.prototype,"answer");
    const stalled=request(new ReadableStream({cancel(){return new Promise(()=>{});}}));
    const pending=POST(stalled);
    await vi.advanceTimersByTimeAsync(BODY_TIMEOUT_MS);
    expect((await pending).status).toBe(408);expect(stalled.body?.locked).toBe(false);expect(vi.getTimerCount()).toBe(0);
    const controller=new AbortController();
    const disconnected=request(new ReadableStream(),{"content-type":"application/json"},controller.signal);
    const aborted=POST(disconnected);controller.abort();
    expect((await aborted).status).toBe(400);expect(disconnected.body?.locked).toBe(false);expect(vi.getTimerCount()).toBe(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("retains exact latest-question source facts and accepts JSON UTF-8 without using client tool output",async()=>{
    const payload={messages:[{role:"assistant",parts:[{type:"tool-showTransactions",output:{amount:999999}}]},
      {role:"user",parts:[{type:"text",text:'How much did I spend on taxis at "Helsinki" last month?'}]}]};
    expect(await readCoachJSON(request(JSON.stringify(payload),{"content-type":"application/json; charset=UTF-8"}))).toEqual(payload);
    const response=await POST(request(JSON.stringify(payload)));
    expect(response.headers.get(REVISION_HEADER)).toBe(COACH_REVISION);
    expect(response.status).toBe(200);const body=await response.text();
    expect(body).toContain("18,90");expect(body).toContain('"amount_minor":-1890');expect(body).not.toContain("999999");
  });

  it("passes cancellation into execution and withholds a completed answer after the client disconnects",async()=>{
    const controller=new AbortController();
    const original=RuleProvider.prototype.answer;
    vi.spyOn(RuleProvider.prototype,"answer").mockImplementationOnce(async function(this:RuleProvider,question,locale,savingsPercent,execution){
      expect(execution?.signal?.aborted).toBe(false);
      const answer=await original.call(this,question,locale,savingsPercent,execution);controller.abort();return answer;
    });
    const response=await POST(request(JSON.stringify({messages:[{role:"user",parts:[{type:"text",text:"How much did I spend on taxis last month?"}]}]}),{"content-type":"application/json"},controller.signal));
    expect(response.status).toBe(400);expect(await response.text()).toBe("");
  });

  it("stops missing/mismatched build responses before SDK decoding while preserving the native transport request",async()=>{
    let canceled=0;
    const network=vi.fn().mockImplementation(async()=>new Response(new ReadableStream({cancel(){canceled++;}}),{headers:{[REVISION_HEADER]:"different-server"}}));
    vi.stubGlobal("fetch",network);
    const controller=new AbortController();
    await expect(coachFetch(url,{method:"POST",body:"native SDK body",signal:controller.signal,headers:{"content-type":"application/json"}})).rejects.toThrow("build changed");
    expect(canceled).toBe(1);
    const [,sent]=network.mock.calls[0];expect(sent.body).toBe("native SDK body");expect(sent.signal).toBe(controller.signal);expect(sent.headers.get(REVISION_HEADER)).toBe(COACH_REVISION);
    network.mockResolvedValueOnce(new Response("unversioned stream"));
    await expect(coachFetch(url)).rejects.toThrow("build changed");
    network.mockResolvedValueOnce(new Response("matching SDK stream",{headers:{[REVISION_HEADER]:COACH_REVISION}}));
    expect(await (await coachFetch(url)).text()).toBe("matching SDK stream");
  });

  it("uses native SDK preparation to send only the last question even when the in-memory thread exceeds the server body budget",async()=>{
    const previous=await new RuleProvider().answer("How much did I spend on taxis last month?","en",10);
    const messages:CoachMessage[]=[...Array.from({length:100},(_,index)=>({id:`old-${index}`,role:"user" as const,parts:[{type:"text" as const,text:"earlier private question ".repeat(60)}]})),previous,
      {id:"private-client-id",role:"user",parts:[{type:"text",text:"What if I cut dining out by 20%?"}]}];
    expect(new TextEncoder().encode(JSON.stringify(messages)).length).toBeGreaterThan(MAX_REQUEST_BYTES);
    const before=structuredClone(messages);
    const network=vi.fn().mockResolvedValue(new Response("data: [DONE]\n\n",{headers:{"content-type":"text/event-stream",[REVISION_HEADER]:COACH_REVISION}}));
    vi.stubGlobal("fetch",network);
    const native=new DefaultChatTransport<CoachMessage>({api:url,fetch:coachFetch,prepareSendMessagesRequest:prepareCoachRequest});
    const stream=await native.sendMessages({trigger:"submit-message",chatId:"private-thread-id",messageId:undefined,messages,abortSignal:undefined,body:{locale:"et",savingsPercent:15,unrelated:"private metadata",context:{tool:"showTransactions",input:{period:{start:"2026-10-01",end:"2026-11-01"},category:"taxi",merchant:"City taxi"}}}});
    await stream.getReader().read();
    const payload=JSON.parse(network.mock.calls[0][1].body);
    expect(payload).toEqual({messages:[{role:"user",parts:[{type:"text",text:"What if I cut dining out by 20%?"}]}],locale:"et",savingsPercent:15});
    expect(messages).toEqual(before);
    const dispatch=vi.spyOn(RuleProvider.prototype,"answer");
    expect((await POST(request(JSON.stringify(payload)))).status).toBe(200);expect(dispatch).toHaveBeenCalledWith("What if I cut dining out by 20%?","et",15,{signal:expect.any(AbortSignal)});
  });
});
