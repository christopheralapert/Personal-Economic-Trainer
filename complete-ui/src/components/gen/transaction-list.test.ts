import {it,expect} from "vitest";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Preferences} from "@/i18n/context";
import {demo,type Transaction} from "@/engine";
import {TransactionList} from "./transaction-list";

it("groups unsorted transaction history once per day while preserving statuses, signs and row order",()=>{
  const rows:Transaction[]=[
    {...demo.transactions[0],id:"first",merchant:"Pending merchant",status:"pending",booked_on:"2026-10-09"},
    {...demo.transactions[0],id:"second",merchant:"Reversed merchant",status:"reversed",booked_on:"2026-10-10",amount_minor:300,economic_flow:"refund"},
    {...demo.transactions[0],id:"third",merchant:"Booked merchant",booked_on:"2026-10-09"},
  ];
  const original=structuredClone(rows);
  const html=renderToStaticMarkup(createElement(Preferences,null,createElement(TransactionList,{rows})));
  expect(html.match(/<section/g)).toHaveLength(2);
  expect(html.match(/<li /g)).toHaveLength(3);
  expect(html.indexOf("10.10.2026")).toBeLessThan(html.indexOf("9.10.2026"));
  expect(html.indexOf("Pending merchant")).toBeLessThan(html.indexOf("Booked merchant"));
  expect(html).toContain("Reserved");expect(html).toContain("Reversed");expect(html).toContain("Booked");
  expect(html).toContain("+3,00");expect(html).toContain("−18,90");expect(rows).toEqual(original);
});

it("bounds initial DOM to one page even for a ten-thousand-row history",()=>{
  const rows=Array.from({length:10000},(_,index)=>({...demo.transactions[0],id:String(index),merchant:`History test ${index}`}));
  const html=renderToStaticMarkup(createElement(Preferences,null,createElement(TransactionList,{rows})));
  expect(html.match(/<li /g)).toHaveLength(25);
  expect(html).toContain("Page 1 of 400");expect(html).not.toContain("History test 25<");
});
