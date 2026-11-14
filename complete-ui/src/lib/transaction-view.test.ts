import {it,expect} from "vitest";
import {demo} from "@/engine";
import {orderedTransactions,searchTransactions} from "./transaction-view";

it("searches literal localized source labels and orders large histories without loss or mutation",()=>{
  const rows=Array.from({length:10000},(_,index)=>({...demo.transactions[0],id:String(index),merchant:`Merchant ${index}`,booked_on:new Date(Date.UTC(2026,0,1+index%365)).toISOString().slice(0,10)}));
  const ordered=orderedTransactions(rows);
  expect(ordered).toHaveLength(10000);expect(new Set(ordered.map(row=>row.id)).size).toBe(10000);
  expect(ordered[0].booked_on).toBe("2026-12-31");expect(ordered[0].id).toBe("364");expect(rows[0].id).toBe("0");
  expect(searchTransactions(demo.transactions," HELSINKI ")).toHaveLength(2);
  expect(searchTransactions(demo.transactions,"TAKSIT",{taxi:"Taksit"})).toHaveLength(3);
  expect(searchTransactions(demo.transactions,"%")).toEqual([]);
  expect(searchTransactions(demo.transactions,"[.*]")).toEqual([]);
  expect(searchTransactions(demo.transactions,"")).toBe(demo.transactions);
});
