"use client";
import {useMoneyData} from "@/lib/money-data-context";
import {useMemo} from "react";
import {useViewState} from "@/lib/view-state";
import {useCopy} from "@/i18n/context";
import {type Period,type TransactionFilters,type TransactionStatusFilter} from "@/engine";
import {transactionPage,type HistoryPage} from "@/engine/history";
import {TransactionList} from "./transaction-list";

export function useHistorySnapshot({rows,page,pageSize,total,financialCount,netExpenses}:HistoryPage):HistoryPage {
  return useMemo(()=>({rows,page,pageSize,total,financialCount,netExpenses}),[rows,page,pageSize,total,financialCount,netExpenses]);
}

/** Later pages use the same local snapshot, never a model call or a private cache. */
export function HistoryResult({initial,period,filters,status,onAsk}:{initial:HistoryPage;period:Period;filters:TransactionFilters;status:TransactionStatusFilter;onAsk?:(question:string)=>void}) {
  const {data}=useMoneyData(),{t}=useCopy(),key=JSON.stringify([status,period.start,period.end,filters]);
  const [page,setPage]=useViewState(`page:${key}`,initial.page);
  const result=useMemo(()=>page===initial.page ? initial : transactionPage(period,status,data,filters,page,initial.pageSize),[page,initial,period,status,filters,data]);
  if(result.total!==initial.total || result.netExpenses!==initial.netExpenses || result.financialCount!==initial.financialCount)
    return <p role="alert" className="text-sm text-ink-2">{t("historyPageUnavailable")}</p>;
  return <TransactionList rows={result.rows} period={period} filters={filters} onAsk={onAsk} pagination={{page:result.page,pageSize:result.pageSize,total:result.total,onChange:setPage}}/>;
}
