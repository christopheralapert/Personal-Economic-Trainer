import {it,expect} from "vitest";
import {createElement,type ReactNode} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {Preferences} from "@/i18n/context";
import {benchmark,demo,lastMonth,spenderProfile,safeToSpend} from "@/engine";
import {CategoryList} from "./category-list";
import {SpenderProfile} from "./spender-profile";
import {BenchmarkBars} from "./benchmark-bars";
import {SafeToSpendCard} from "./safe-to-spend-card";
import {BasketCard} from "./basket-card";
import {SummaryTiles} from "./summary-tiles";
import {summary} from "@/engine";

it("explains empty categories and withholds missing profile totals and comparison bars",()=>{
  const empty={...demo,transactions:[]};
  const html=renderToStaticMarkup(createElement(Preferences,null,createElement("div",null,
    createElement(CategoryList,{groups:[]}),createElement(SpenderProfile,{result:spenderProfile(lastMonth,empty)}),
    createElement(BenchmarkBars,{result:benchmark("unmapped",undefined,lastMonth,empty)}))));
  expect(html).toContain("No recorded transactions in this scope.");expect(html).toContain("Not available");
  expect(html).not.toContain("0,00");expect(html).not.toContain('role="progressbar"');
  const comparison=renderToStaticMarkup(createElement(Preferences,null,createElement(BenchmarkBars,{result:benchmark("dining")})));
  expect(comparison.match(/role="progressbar"/g)).toHaveLength(1);
  expect(comparison).toContain('aria-valuenow="100"');expect(comparison).toContain('aria-valuetext="250,00');
});

it("keeps absent summary and basket observations distinct from actual zero and escapes source categories",()=>{
  const render=(node:ReactNode)=>renderToStaticMarkup(createElement(Preferences,null,node));
  const html=render(createElement("div",null,createElement(BasketCard,{groups:[]}),createElement(SummaryTiles,summary(lastMonth,{...demo,transactions:[]}))));
  expect(html).toContain("Not recorded");expect(html).not.toContain("0,00");expect(html).not.toMatch(/>0\s*%/);
  const zero=render(createElement(BasketCard,{groups:[{key:"everyday",gross:100,refunds:100,amount:0,count:2}]}));
  expect(zero).toContain("0,00");
  const labels=render(createElement(CategoryList,{groups:["send","constructor","__proto__","<img src=x>"].map(key=>({key,gross:100,refunds:0,amount:100,count:1}))}));
  expect(labels).toContain("constructor");expect(labels).toContain("__proto__");expect(labels).toContain("&lt;img src=x&gt;");expect(labels).not.toContain("<img");
});

it("explains missing balances without publishing a partial total or a spending allowance",()=>{
  const missing={...demo,balances:demo.balances.slice(1)},result=safeToSpend("2026-11-04",missing);
  expect(result.balance).toBeNull();expect(result.illustrativeHeadroom).toBeNull();
  const html=renderToStaticMarkup(createElement(Preferences,null,createElement(SafeToSpendCard,{result})));
  expect(html).toContain("A usable balance is missing");expect(html).toContain("Transaction history is incomplete.");
  expect(html).toContain("Source snapshot: 4.11.2026");expect(html).not.toContain("300,00");
});
