import {it,expect} from "vitest";
import {categoryBreakdown} from "./category-breakdown";
import {categoryLabel,categoryKey,translate} from "@/i18n/translate";
import {exactSum,type Group} from "@/engine";

const group=(key:string,gross:number,refunds=0):Group=>({key,gross,refunds,amount:gross-refunds,count:1});

it("keeps an uncategorised payment slice visible without changing category totals",()=>{
  const groups=[group("housing",5000),group("dining",4000),group("taxi",3000),group("coffee",2000),group("unclassified",100)];
  const result=categoryBreakdown(groups);
  expect(result.segments).toHaveLength(4);
  expect(result.segments.find(segment=>segment.category==="unclassified")?.gross).toBe(100);
  expect(exactSum(result.segments.map(segment=>segment.gross))).toBe(14100);
  for(const locale of ["en","fi","et"] as const)expect(categoryLabel("unclassified",key=>translate(locale,key))).toBe(translate(locale,"notCategorised"));
});

it("partitions every category once, keeps real Other distinct and reconciles gross, refunds and net exactly",()=>{
  const groups=[group("other",5000),group("dining",4000),group("taxi",3000),group("coffee",2000),group("send",1000,300),group("constructor",0,200)];
  const before=structuredClone(groups),result=categoryBreakdown(groups);
  expect(result).toMatchObject({gross:15000,refunds:500,net:14500});
  expect(result.segments).toHaveLength(4);expect(new Set(result.segments.map(segment=>segment.id)).size).toBe(4);
  expect(result.segments[0]).toMatchObject({category:"other",members:[groups[0]]});
  expect(result.segments[3]).toMatchObject({category:null,gross:3000,refunds:300,amount:2700,members:[groups[3],groups[4]]});
  expect(result.withoutGross).toEqual([groups[5]]);
  expect(exactSum(result.segments.map(segment=>segment.amount))+exactSum(result.withoutGross.map(row=>row.amount))).toBe(result.net);
  expect(groups).toEqual(before);
});

it("keeps refund-only and observed-zero groups outside the expense ring and rejects inaccurate arithmetic",()=>{
  const result=categoryBreakdown([group("refund only",0,300),group("observed zero",0)]);
  expect(result).toMatchObject({segments:[],gross:0,refunds:300,net:-300});expect(result.withoutGross).toHaveLength(2);
  expect(()=>categoryBreakdown([group("a",Number.MAX_SAFE_INTEGER),group("b",1)])).toThrow();
  expect(()=>categoryBreakdown([group("a",10),group("a",20)])).toThrow();
  expect(()=>categoryBreakdown([{...group("a",100),amount:99}])).toThrow();
});

it("translates only declared category identifiers and retains literal labels in each language",()=>{
  for(const locale of ["en","fi","et"] as const) {
    const t=(key:Parameters<typeof translate>[1])=>translate(locale,key);
    expect(categoryLabel("taxi",t)).toBe(t("taxi"));
    for(const label of ["send","constructor","__proto__","toString","<img src=x>","New source category"]) {
      expect(categoryLabel(label,t)).toBe(label);expect(categoryKey(label)).toBe("other");
    }
  }
});
