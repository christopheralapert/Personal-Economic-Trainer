import {exactSum,type Group} from "@/engine";
export type CategorySegment={id:string;category:string|null;members:Group[];gross:number;refunds:number;amount:number;count:number};

/** Most named segments before smaller categories roll up (keeps the ring readable). */
export const maxNamedSegments=8;
/** The rolled-up remainder must stay below this share of gross spending. */
export const rollupLimit=0.2;

/**
 * Named segments in descending order until the remainder is below 20% of gross spending (at most eight).
 * "Not categorised" is always its own segment and never part of the rollup; the rollup has an identity distinct
 * from every source category and is never a single category in disguise.
 */
export function categoryBreakdown(groups:Group[]) {
  const keys=new Set<string>();
  for(const group of groups) {
    if(keys.has(group.key) || group.gross<0 || group.refunds<0 || group.count<0) throw new Error("Invalid category groups");
    keys.add(group.key);
    exactSum([group.gross]);exactSum([group.refunds]);exactSum([group.count]);
    if(exactSum([group.gross,-group.refunds])!==group.amount) throw new Error("Category totals do not reconcile");
  }
  const positive=groups.filter(group=>group.gross>0).sort((a,b)=>b.gross-a.gross || a.key.localeCompare(b.key));
  const gross=exactSum(groups.map(group=>group.gross));
  function segment(members:Group[],category:string|null):CategorySegment {
    return {id:category===null ? "rollup" : `category:${JSON.stringify(category)}`,category,members,
      gross:exactSum(members.map(group=>group.gross)),refunds:exactSum(members.map(group=>group.refunds)),
      amount:exactSum(members.map(group=>group.amount)),count:exactSum(members.map(group=>group.count))};
  }
  // Reviewable money must not disappear inside an anonymous Other rollup.
  const unclassified=positive.find(group=>group.key==="unclassified");
  const candidates=positive.filter(group=>group!==unclassified);
  const named:Group[]=[];
  let rest=candidates;
  while(rest.length && named.length<maxNamedSegments && exactSum(rest.map(group=>group.gross))>=rollupLimit*gross) {named.push(rest[0]);rest=rest.slice(1);}
  // A rollup of one is just that category.
  if(rest.length===1){named.push(rest[0]);rest=[];}
  const rollup=rest.length ? segment(rest,null) : null;
  const segments=[...named.map(group=>segment([group],group.key)),...(rollup ? [rollup] : []),...(unclassified ? [segment([unclassified],unclassified.key)] : [])];
  return {segments,withoutGross:groups.filter(group=>group.gross===0),
    rollupShare:rollup && gross>0 ? rollup.gross/gross : 0,
    gross,refunds:exactSum(groups.map(group=>group.refunds)),net:exactSum(groups.map(group=>group.amount))};
}
