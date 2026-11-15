import {demo,monthPeriod,records,spendByBasket,safeToSpend,basisPointAmount,exactSum,type Dataset,type Period} from "./index";
import {sourceDate} from "./source-date";
export function recurringIncome(data:Dataset=demo,today=sourceDate(data.as_of)) {
 const groups=new Map<string,ReturnType<typeof records>>();
 for(const row of records({start:monthPeriod(today,-5).start,end:today},data)) if(row.economic_flow==="income" && row.amount_minor>0) {const key=`${row.account_id}/${row.merchant.trim().toLocaleLowerCase()}`;groups.set(key,[...(groups.get(key)??[]),row]);}
 const candidates=[];
 for(const rows of groups.values()) {
  rows.sort((a,b)=>a.booked_on.localeCompare(b.booked_on));const recent=rows.slice(-3);
  if(recent.length<3 || recent[2].booked_on<monthPeriod(today,-1).start) continue;
  const amounts=recent.map(r=>r.amount_minor).sort((a,b)=>a-b),median=amounts[1];
  if(recent.some(r=>Math.abs(r.amount_minor-median)>median*.2)) continue;
  if(recent.slice(1).some((r,i)=>{const days=(Date.parse(r.booked_on)-Date.parse(recent[i].booked_on))/86400000;return days<25 || days>35;})) continue;
  candidates.push(median);
 }
 if(candidates.length) return exactSum(candidates);
 // Payers often move salary days around holidays. Accept one stable payer whose
 // monthly totals were present in each of the last three complete months.
 const payers=new Map<string,number[]>();
 for(let offset=1;offset<=3;offset++) {
  const totals=new Map<string,number>();
  for(const row of records(monthPeriod(today,-offset),data)) if(row.economic_flow==="income" && row.amount_minor>0) {
   const key=`${row.account_id}/${row.merchant.replace(/\d{4}-\d{2}-\d{2}|\d+/gu,"").replace(/[\s/.,-]+$/u,"").trim().toLocaleLowerCase()}`;
   totals.set(key,exactSum([totals.get(key) ?? 0,row.amount_minor]));
  }
  for(const [key,total] of totals) payers.set(key,[...(payers.get(key) ?? []),total]);
 }
 const stable=[...payers.values()].filter(values=>values.length===3).map(values=>{const sorted=[...values].sort((a,b)=>a-b);return {median:sorted[1],ok:sorted.every(value=>Math.abs(value-sorted[1])<=sorted[1]*.2)};}).filter(item=>item.ok);
 return stable.length ? exactSum(stable.map(item=>item.median)) : null;
}
/** Estimate describes a cautious historical planning range, never adds projected income to funds. */
export function weeklyRange({data=demo,today=sourceDate(data.as_of),income=null,savingsPercent=10,billsConfirmed=false,classificationsReviewed=false}:{data?:Dataset;today?:string;income?:number|null;savingsPercent?:number;billsConfirmed?:boolean;classificationsReviewed?:boolean}={}) {
 if(income!==null && (!Number.isSafeInteger(income)||income<=0)) throw new Error("Invalid estimated income");
 const review=safeToSpend(today,data,savingsPercent),estimate=income??recurringIncome(data,today);
 const observed=Array.from({length:3},(_,i)=>spendByBasket(monthPeriod(today,-i-1),data).find(g=>g.key==="everyday")?.amount).filter((n):n is number=>n!==undefined && n>0);
 const typical=observed.length ? Math.floor(exactSum(observed)/observed.length*7/30.4375) : null;
 // Estimates reduce existing headroom through a target reserve, never increase its balance.
 const target=estimate===null ? 0 : basisPointAmount(estimate,savingsPercent*100);
 const available=review.illustrativeHeadroom===null ? null : Math.max(0,review.illustrativeHeadroom-Math.max(0,target-(review.savings??0)));
 // A checkbox cannot establish complete financial coverage. The demo stays
 // low-confidence; the authenticated dated planner owns reviewed allowances.
 const confidence="low" as const;
 const cap=available===null ? null : Math.floor(available*.25);
 const fresh=!review.reasons.some(reason=>reason==="date_mismatch" || reason==="balances_outdated");
 const high=typical===null || cap===null || !fresh ? null : Math.min(cap,typical);
 return {low:high===null ? null : Math.floor(high*.6),high,cap,confidence,estimate,incomeSource:income!==null ? "user" as const : estimate!==null ? "inferred" as const : null,typical,review,billsConfirmed,classificationsReviewed,observedMonths:observed.length};
}
export function defaultPeriod(data:Dataset=demo):Period {
 const today=sourceDate(data.as_of),month=monthPeriod(today),end=new Date(today+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);
 const current={start:month.start,end:end.toISOString().slice(0,10)};
 return Number(today.slice(-2))<10 || records(current,data).length<5 ? monthPeriod(today,-1) : current;
}
