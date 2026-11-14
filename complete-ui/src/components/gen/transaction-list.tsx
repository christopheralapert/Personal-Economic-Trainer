"use client";
import {useEffect,useMemo,useRef} from "react";
import {useViewState} from "@/lib/view-state";
import {useCopy} from "@/i18n/context";
import {date} from "@/lib/format";
import {TransactionRow} from "./transaction-row";
import type {Transaction,Period,TransactionFilters} from "@/engine";
import {orderedTransactions,TRANSACTION_PAGE_SIZE} from "@/lib/transaction-view";
import {Button} from "@/components/ui/button";
type Pagination={page:number;pageSize:number;total:number;onChange:(page:number)=>void};
export function TransactionList({rows,stateKey="default",period,onAsk,pagination,filters,onCorrect}:{rows:Transaction[];stateKey?:string;period?:Period;onAsk?:(question:string)=>void;filters?:TransactionFilters;pagination?:Pagination;onCorrect?:(row:Transaction)=>void}) {
  const {t}=useCopy(),[page,setPage]=useViewState(`page:${stateKey}`,0),heading=useRef<HTMLHeadingElement>(null),focusPage=useRef(false);
  const ordered=useMemo(()=>orderedTransactions(rows),[rows]);
  const total=pagination?.total ?? ordered.length,pages=Math.max(1,Math.ceil(total/(pagination?.pageSize ?? TRANSACTION_PAGE_SIZE))),current=pagination?.page ?? Math.min(page,pages-1),byDay=new Map<string,Transaction[]>();
  for(const row of pagination ? ordered : ordered.slice(current*TRANSACTION_PAGE_SIZE,(current+1)*TRANSACTION_PAGE_SIZE)) {const day=byDay.get(row.booked_on);if(day) day.push(row);else byDay.set(row.booked_on,[row]);}
  const days=[...byDay.keys()].sort().reverse();
  useEffect(()=>{if(focusPage.current){heading.current?.focus({preventScroll:true});heading.current?.scrollIntoView({block:"start",behavior:"instant"});focusPage.current=false;}},[current]);
  function changePage(next:number){focusPage.current=true;if(pagination) pagination.onChange(next);else setPage(next);}
  return days.length ? <div className="space-y-5">{days.map((day,index)=><section key={day}><h3 ref={index===0 ? heading : undefined} tabIndex={-1} className="mb-1 text-caption font-semibold text-ink-2">{date(day)}</h3><ul className="divide-y divide-line">{byDay.get(day)!.map(row=><TransactionRow key={row.id} row={row} period={period} filters={filters} onAsk={onAsk} onCorrect={onCorrect}/>)}</ul></section>)}{pages>1 && <nav aria-label={t("transactionPages")} className="space-y-3 border-t border-line pt-4"><p role="status" className="text-caption text-ink-2">{t("historyPage",{page:current+1,pages,count:total})}</p><div className="grid grid-cols-2 gap-3"><Button variant="outline" disabled={current===0} onClick={()=>changePage(current-1)}>{t("previousPage")}</Button><Button variant="outline" disabled={current===pages-1} onClick={()=>changePage(current+1)}>{t("nextPage")}</Button></div></nav>}</div> : <p className="text-ink-2">{t("emptyRecords")}</p>;
}
