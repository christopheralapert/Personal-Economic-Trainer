import {it,expect} from "vitest";
import {clearCoachStorage} from "./local-data";
it("deletes only the coach's local namespaces",()=>{
 const values=new Map([["money-coach-preferences.v1","fixture"],["money-coach-thread.v1.en","fixture"],["other-application","keep"]]);
 clearCoachStorage({get length(){return values.size;},key:index=>[...values.keys()][index]??null,removeItem:key=>{values.delete(key);}});
 expect([...values]).toEqual([["other-application","keep"]]);
});
