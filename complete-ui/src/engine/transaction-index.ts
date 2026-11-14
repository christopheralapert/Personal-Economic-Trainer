import {isLoadedSnapshot,type Dataset,type Transaction} from "./data";
import {sourceDate} from "./source-date";

type Entry={row:Transaction;order:number;merchant:string};
const indexes=new WeakMap<Dataset,ReturnType<typeof createIndex>>();
function visible(data:Dataset):Transaction[] {
  const included=new Set(data.accounts.filter(account=>account.included).map(account=>account.id));
  const through=sourceDate(data.as_of);
  return data.transactions.filter(row=>included.has(row.account_id) && row.booked_on<=through);
}
function createIndex(data:Dataset) {
  const rows=visible(data),dates=rows.map((row,order)=>({row,order,merchant:row.merchant.toLowerCase()}));
  dates.sort((a,b)=>a.row.booked_on.localeCompare(b.row.booked_on) || a.order-b.order);
  function lowerBound(date:string) {
    let lo=0,hi=dates.length;
    while(lo<hi) {const mid=lo+Math.floor((hi-lo)/2);if(dates[mid].row.booked_on<date) lo=mid+1;else hi=mid;}
    return lo;
  }
  return {all:()=>rows.slice(),between:(start:string,end:string,accept:(row:Transaction,merchant:string)=>boolean)=>{
    const selected:Entry[]=[];
    for(let i=lowerBound(start),stop=lowerBound(end);i<stop;i++) if(accept(dates[i].row,dates[i].merchant)) selected.push(dates[i]);
    // Public reads retain source order, including equal-date records and transfers.
    selected.sort((a,b)=>a.order-b.order);return selected.map(entry=>entry.row);
  }};
}
function index(data:Dataset) {
  let result=indexes.get(data);if(!result) {result=createIndex(data);indexes.set(data,result);}return result;
}
/** Mutable caller-owned fixtures are always read afresh, never cached by identity. */
export function visibleTransactions(data:Dataset):Transaction[] {return isLoadedSnapshot(data) ? index(data).all() : visible(data);}
export function periodTransactions(data:Dataset,start:string,end:string,accept:(row:Transaction,merchant:string)=>boolean):Transaction[] {
  return isLoadedSnapshot(data) ? index(data).between(start,end,accept)
    : visible(data).filter(row=>row.booked_on>=start && row.booked_on<end && accept(row,row.merchant.toLowerCase()));
}
