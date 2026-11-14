import {demo,records,monthPeriod,exactSum,type Dataset,type Period} from "./index";
import {sourceDate} from "./source-date";
export type RecurringItem={merchant:string;flow:"income"|"expense";amount:number;due:string};
/** Three observed monthly payments are evidence of cadence, never guaranteed future funds. */
export function recurringItems(data:Dataset=demo):RecurringItem[] {
 const today=sourceDate(data.as_of),groups=new Map<string,ReturnType<typeof records>>();
 for(const row of records({start:monthPeriod(today,-5).start,end:today},data)) {
  if(row.economic_flow!=="income" && !(row.economic_flow==="expense" && row.basket==="mandatory_regular"))continue;
  const key=`${row.account_id}/${row.economic_flow}/${row.merchant.trim().toLowerCase()}`;
  const rows=groups.get(key);if(rows)rows.push(row);else groups.set(key,[row]);
 }
 const result:RecurringItem[]=[];
 for(const rows of groups.values()) {
  const recent=rows.sort((a,b)=>a.booked_on.localeCompare(b.booked_on)).slice(-3);
  if(recent.length!==3)continue;
  const amounts=recent.map(r=>Math.abs(r.amount_minor)).sort((a,b)=>a-b),amount=amounts[1];
  if(amount===0 || amounts.some(n=>Math.abs(n-amount)>amount*.2))continue;
  if(recent.slice(1).some((row,i)=>{const days=(Date.parse(row.booked_on)-Date.parse(recent[i].booked_on))/86400000;return days<25 || days>35;}))continue;
  const last=recent[2],next=monthPeriod(last.booked_on,1),monthDays=(Date.parse(next.end)-Date.parse(next.start))/86400000;
  const due=next.start.slice(0,8)+String(Math.min(Number(last.booked_on.slice(-2)),monthDays)).padStart(2,"0");
  if(due<today)continue;
  result.push({merchant:last.merchant,flow:last.economic_flow as RecurringItem["flow"],amount,due});
 }
 return result.sort((a,b)=>a.due.localeCompare(b.due));
}
export function billsAhead(data:Dataset=demo) {
 const recurring=recurringItems(data),income=recurring.find(row=>row.flow==="income");
 return income ? recurring.filter(row=>row.flow==="expense" && row.due<=income.due) : [];
}
/** A coverage heuristic gates illustrations. A sparse ledger is never treated as a complete budget. */
export function monthOutlook(period:Period,data:Dataset=demo) {
 const today=sourceDate(data.as_of),current=monthPeriod(period.start);
 if(period.start!==current.start || current.start>monthPeriod(today).start || period.end>current.end)return null;
 const end=new Date(today+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);
 const observedEnd=[end.toISOString().slice(0,10),current.end].sort()[0];if(period.end<observedEnd)return null;
 const selected=records({start:current.start,end:observedEnd},data).filter(r=>r.economic_flow==="expense" || r.economic_flow==="refund");
 const historical=Array.from({length:3},(_,i)=>{const month=monthPeriod(current.start,-i-1);return {month,rows:records(month,data).filter(r=>r.economic_flow==="expense" || r.economic_flow==="refund")};});
 if(new Set(selected.map(r=>r.booked_on)).size<5 || historical.some(h=>new Set(h.rows.map(r=>r.booked_on)).size<10))return null;
 const days=(Date.parse(current.end)-Date.parse(current.start))/86400000,observedDay=current.end<=observedEnd ? days : Number(today.slice(-2));
 const points=Array.from({length:days},(_,index)=>{
  const day=index+1,totals=historical.map(({month,rows})=>{const length=(Date.parse(month.end)-Date.parse(month.start))/86400000;return exactSum(rows.filter(r=>Number(r.booked_on.slice(-2))/length<=day/days).map(r=>-r.amount_minor));});
  return {day,actual:day<=observedDay ? exactSum(selected.filter(r=>Number(r.booked_on.slice(-2))<=day).map(r=>-r.amount_minor)) : null,typical:Math.round(exactSum(totals)/totals.length),band:[Math.min(...totals),Math.max(...totals)] as [number,number]};
 });
 return {period:current,points,count:selected.length};
}
