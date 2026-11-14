import type {Transaction} from "@/engine";

export {HISTORY_PAGE_SIZE as TRANSACTION_PAGE_SIZE,orderedTransactions} from "@/engine/history";
export function searchTransactions(rows:Transaction[],query:string,labels:Record<string,string>={}):Transaction[] {
  const needle=query.trim().normalize("NFKC").toLowerCase();
  if(!needle) return rows;
  return rows.filter(row=>[row.merchant,row.category,labels[row.category] ?? ""].some(value=>value.normalize("NFKC").toLowerCase().includes(needle)));
}
