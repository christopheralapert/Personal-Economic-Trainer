"use client";
import {useMemo,useRef,type CSSProperties} from "react";
import {useVirtualizer} from "@tanstack/react-virtual";
import type {Transaction,Period} from "@/engine";
import {orderedTransactions} from "@/engine/history";
import {estimatedTransactionHeight} from "@/lib/virtual-measure";
import {date} from "@/lib/format";
import {useCopy} from "@/i18n/context";
import {TransactionRow} from "./gen/transaction-row";
type Item={key:string;day:string;row:Transaction|null};
export function VirtualTransactions({rows,period,onCorrect}:{rows:Transaction[];period:Period;onCorrect:(row:Transaction)=>void}) {
 "use no memo";
 const {t}=useCopy(),parent=useRef<HTMLDivElement>(null),items=useMemo(()=>{const values:Item[]=[];let previous="";for(const row of orderedTransactions(rows)){if(row.booked_on!==previous){values.push({key:`day-${row.booked_on}`,day:row.booked_on,row:null});previous=row.booked_on;}values.push({key:row.id,day:row.booked_on,row});}return values;},[rows]);
 const virtual=useVirtualizer({count:items.length,getScrollElement:()=>parent.current,estimateSize:estimatedTransactionHeight,overscan:5,getItemKey:index=>items[index].key});
 return <div ref={parent} role="region" aria-label={t("transactions")} tabIndex={0} className="h-80 overflow-auto"><div className="virtual-track" style={{"--virtual-total":virtual.getTotalSize()} as CSSProperties}>{virtual.getVirtualItems().map(item=><div key={item.key} data-index={item.index} ref={virtual.measureElement} className="virtual-row" style={{"--virtual-offset":item.start} as CSSProperties}>{items[item.index].row ? <ul className="border-b border-line"><TransactionRow row={items[item.index].row!} period={period} onCorrect={onCorrect}/></ul> : <h3 className="py-3 text-caption font-semibold text-ink-2">{date(items[item.index].day)}</h3>}</div>)}</div></div>;
}
