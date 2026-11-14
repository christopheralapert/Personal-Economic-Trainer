import {exactSum,type Group} from "@/engine";
export type CategorySegment={id:string;category:string|null;members:Group[];gross:number;refunds:number;amount:number;count:number};

/** Four readable segments; the rollup has an identity distinct from every source category. */
export function categoryBreakdown(groups:Group[]) {
  const keys=new Set<string>();
  for(const group of groups) {
    if(keys.has(group.key) || group.gross<0 || group.refunds<0 || group.count<0) throw new Error("Invalid category groups");
    keys.add(group.key);
    exactSum([group.gross]);exactSum([group.refunds]);exactSum([group.count]);
    if(exactSum([group.gross,-group.refunds])!==group.amount) throw new Error("Category totals do not reconcile");
  }
  const positive=groups.filter(group=>group.gross>0).sort((a,b)=>b.gross-a.gross || a.key.localeCompare(b.key));
  function segment(members:Group[],category:string|null):CategorySegment {
    return {id:category===null ? "rollup" : `category:${JSON.stringify(category)}`,category,members,
      gross:exactSum(members.map(group=>group.gross)),refunds:exactSum(members.map(group=>group.refunds)),
      amount:exactSum(members.map(group=>group.amount)),count:exactSum(members.map(group=>group.count))};
  }
  const unclassified=positive.find(group=>group.key==="unclassified");
  const leading=positive.slice(0,3);
  // Reviewable money must not disappear inside an anonymous Other rollup.
  if(unclassified && !leading.includes(unclassified))leading.splice(2,1,unclassified);
  const segments=positive.length>4
    ? [...leading.map(group=>segment([group],group.key)),segment(positive.filter(group=>!leading.includes(group)),null)]
    : positive.map(group=>segment([group],group.key));
  return {segments,withoutGross:groups.filter(group=>group.gross===0),
    gross:exactSum(groups.map(group=>group.gross)),refunds:exactSum(groups.map(group=>group.refunds)),net:exactSum(groups.map(group=>group.amount))};
}
