import {z} from "zod";
import {demo,exactSum,transactionHistory,type Dataset,type Period,type Transaction,type TransactionFilters,type TransactionStatusFilter} from "./index";
import {transactionSchema} from "./data";

export const HISTORY_PAGE_SIZE=25;
/** Date descending, retaining source order within a day. Never mutate the input. */
export function orderedTransactions(rows:Transaction[]):Transaction[] {
  const groups=new Map<string,Transaction[]>();
  for(const row of rows){const day=groups.get(row.booked_on);if(day) day.push(row);else groups.set(row.booked_on,[row]);}
  return [...groups.keys()].sort().reverse().flatMap(day=>groups.get(day)!);
}
export const historyPageSchema=z.object({
  rows:z.array(transactionSchema).max(HISTORY_PAGE_SIZE),page:z.number().int().safe().nonnegative(),
  pageSize:z.number().int().min(1).max(HISTORY_PAGE_SIZE),total:z.number().int().safe().nonnegative(),
  financialCount:z.number().int().safe().nonnegative(),netExpenses:z.number().int().safe().nullable(),
}).strict().superRefine((value,ctx)=>{
  const pages=Math.max(1,Math.ceil(value.total/value.pageSize));
  const count=Math.min(value.pageSize,value.total-value.page*value.pageSize);
  const visibleFinancial=value.rows.filter(row=>row.status==="booked" && (row.economic_flow==="expense" || row.economic_flow==="refund"));
  const complete=value.rows.length===value.total;
  const visibleNet=visibleFinancial.reduce((sum,row)=>sum-BigInt(row.amount_minor),0n);
  if(value.page>=pages || value.rows.length!==count || value.financialCount>value.total || (value.netExpenses===null)!==(value.financialCount===0)
    || visibleFinancial.length>value.financialCount || (complete && (visibleFinancial.length!==value.financialCount || (value.netExpenses!==null && BigInt(value.netExpenses)!==visibleNet)))
    || new Set(value.rows.map(row=>row.id)).size!==value.rows.length)
    ctx.addIssue({code:"custom",message:"Inconsistent history page"});
});
export type HistoryPage=z.infer<typeof historyPageSchema>;
/** Row payloads are bounded; totals describe ALL matching booked expense/refund observations. */
export function transactionPage(period:Period,status:TransactionStatusFilter="all",data:Dataset=demo,filters:TransactionFilters={},page=0,pageSize=HISTORY_PAGE_SIZE):HistoryPage {
  z.number().int().safe().nonnegative().parse(page);z.number().int().min(1).max(HISTORY_PAGE_SIZE).parse(pageSize);
  const rows=transactionHistory(period,status,data,filters),ordered=orderedTransactions(rows);
  const financial=rows.filter(row=>row.status==="booked" && (row.economic_flow==="expense" || row.economic_flow==="refund"));
  const current=Math.min(page,Math.max(0,Math.ceil(rows.length/pageSize)-1));
  return {rows:ordered.slice(current*pageSize,(current+1)*pageSize),page:current,pageSize,total:rows.length,
    financialCount:financial.length,netExpenses:financial.length ? exactSum(financial.map(row=>-row.amount_minor)) : null};
}
