"use client";
import {useCopy,categoryLabel} from "@/i18n/context";
import {useMoneyData} from "@/lib/money-data-context";
import {signedMoney} from "@/lib/format";
import {transactionQuestion} from "@/coach/explore-question";
import type {Period,Transaction,TransactionFilters} from "@/engine";
import {CategoryIcon} from "./category-icon";
import {Button} from "../ui/button";
export function TransactionRow({row,period,filters,onAsk,onCorrect}:{row:Transaction;period?:Period;filters?:TransactionFilters;onAsk?:(question:string)=>void;onCorrect?:(row:Transaction)=>void}) {
 const {t,locale}=useCopy(),{queue}=useMoneyData(),question=period && onAsk ? transactionQuestion(period,{...filters,merchant:row.merchant},locale) : null;
 return <li className="grid grid-cols-transaction min-h-14 items-center gap-x-3 gap-y-1 py-3"><CategoryIcon category={queue.some(item=>item.id===row.id) ? "unknown" : row.category} size="dense"/><div className="min-w-0 flex-1">{question ? <Button variant="link" className="h-auto min-h-12 max-w-full justify-start whitespace-normal p-0 text-left font-normal wrap-anywhere" aria-label={t("exploreMerchant",{merchant:row.merchant})} onClick={()=>onAsk?.(question)}>{row.merchant}</Button> : <p className="wrap-anywhere">{row.merchant}</p>}<p className="wrap-anywhere text-caption text-ink-2">{categoryLabel(row.category,t)} · {t(row.status==="pending" ? "reserved" : row.status==="reversed" ? "reversed" : "booked")}</p></div><span className={`ml-auto shrink-0 font-medium ${row.amount_minor<0 ? "text-neg" : "text-pos"}`}>{signedMoney(row.amount_minor)}</span>{onCorrect && (row.economic_flow==="expense" || row.economic_flow==="refund") && <Button variant="link" className="col-span-2 col-start-2 h-auto min-h-12 max-w-full justify-self-start p-0 text-sm" aria-label={t("correctTransaction",{merchant:row.merchant})} onClick={()=>onCorrect(row)}>{t(row.basket_basis ? "basketWhy" : "wrongCategory")}</Button>}</li>;
}
