import {demo,records,monthPeriod,spendByCategory,exactSum,type Dataset,type Period} from "./index";
import {sourceDate} from "./source-date";
export type ProactiveInsight={id:string;kind:"share"|"change";category:string|null;share:number|null;amount:number;period:Period};
/** Observations only. Sparse month-to-month comparisons and incompatible benchmarks stay hidden. */
export function proactiveInsights(period:Period,data:Dataset=demo):ProactiveInsight[] {
 const rows=records(period,data).filter(row=>row.economic_flow==="expense" && row.basket==="everyday"),totals=new Map<string,number>();
 for(const row of rows)totals.set(row.category,exactSum([totals.get(row.category)??0,-row.amount_minor]));
 const total=exactSum([...totals.values()]),leading=[...totals].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0]))[0],result:ProactiveInsight[]=[];
 if(leading && total>0)result.push({id:`share/${period.start}/${leading[0]}`,kind:"share",category:leading[0],share:leading[1]/total*100,amount:leading[1],period});
 const previous=monthPeriod(period.start,-1),past=records(previous,data).filter(row=>row.economic_flow==="expense"),current=records(period,data).filter(row=>row.economic_flow==="expense");
 if(previous.end<=sourceDate(data.as_of) && past.length>=5 && current.length>=5) {
  const amount=exactSum([exactSum(spendByCategory(period,data).map(g=>g.amount)),-exactSum(spendByCategory(previous,data).map(g=>g.amount))]);
  if(Math.abs(amount)>=100)result.push({id:`change/${period.start}`,kind:"change",category:null,share:null,amount,period});
 }
 return result.slice(0,3);
}
