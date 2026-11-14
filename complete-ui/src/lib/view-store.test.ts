import {it,expect} from "vitest";
import {createViewStore} from "./view-store";

it("isolates visits and fields, retains exact values and notifies only changed subscribers",()=>{
  const first=createViewStore(),second=createViewStore();let calls=0,other=0,initializations=0;
  const read=()=>first.get("card/pct",()=>{initializations++;return 20.25;});
  const unsubscribe=first.subscribe("card/pct",()=>{calls++;});first.subscribe("other",()=>{other++;});
  expect(read()).toBe(20.25);expect(read()).toBe(20.25);expect(initializations).toBe(1);
  first.set("card/pct",previous=>previous+.25,20);expect(read()).toBe(20.5);expect(calls).toBe(1);expect(other).toBe(0);
  first.set("card/pct",20.5,20);expect(calls).toBe(1);
  expect(second.get("card/pct",20)).toBe(20);unsubscribe();first.set("card/pct",0,20);expect(calls).toBe(1);
  expect(first.get("constructor",10)).toBe(10);expect(first.get("__proto__",11)).toBe(11);
});
