import {it,expect} from "vitest";
import {decodeThread,encodeThread} from "./session-thread";
import {RuleProvider} from "@/coach/rule-provider";
it("restores one instance of each message, separates languages and rejects corrupt/stale state",async()=>{
 const answer=await new RuleProvider().answer("How much did I spend on taxis last month?","en",10),native={...answer,parts:[{type:"step-start" as const},...answer.parts]},raw=encodeThread([native,native],"en");
 expect(decodeThread(raw,"en")).toHaveLength(1);expect(decodeThread(raw,"fi")).toEqual([]);
 expect(decodeThread(raw!.replace(/"revision":"[^"]+"/,'"revision":"obsolete"'),"en")).toEqual([]);
 expect(decodeThread('{"messages":[{"role":"system"}]}',"en")).toEqual([]);expect(decodeThread("x".repeat(250001),"en")).toEqual([]);
});

it("does not restore messages from a different MyData selection",async()=>{
 const answer=await new RuleProvider().answer("How much did I spend on taxis last month?","en",10),raw=encodeThread([answer],"en","taxi-included");
 expect(decodeThread(raw,"en","taxi-included")).toHaveLength(1);expect(decodeThread(raw,"en","taxi-excluded")).toEqual([]);
});
