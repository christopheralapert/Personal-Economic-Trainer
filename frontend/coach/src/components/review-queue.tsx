"use client";
import {useMemo,useState} from "react";
import {useMoneyData} from "@/lib/money-data-context";
import {useCopy} from "@/i18n/context";
import {date,signedMoney} from "@/lib/format";
import type {Basket,Period} from "@/engine";
import {Button} from "./ui/button";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose,DrawerBody} from "./ui/drawer";

/** Payments in the period on screen come first, then older ones. */
export function periodQueue<T extends {booked_on:string}>(queue:T[],period?:Period) {
  if(!period) return queue;
  const inside=(row:T)=>row.booked_on>=period.start && row.booked_on<period.end;
  return [...queue.filter(inside),...queue.filter(row=>!inside(row))];
}

/** One-at-a-time basket review. `variant="pill"` is the outlined "Review" action of the To check row; "hero" is the primary "Review N" button. */
export function ReviewQueue({period,variant="pill",count}:{period?:Period;variant?:"pill"|"hero";count?:number}) {
  const {queue,correct}=useMoneyData(),{t}=useCopy(),[open,setOpen]=useState(false),[skipped,setSkipped]=useState<string[]>([]);
  const ordered=useMemo(()=>periodQueue(queue,period),[queue,period]),current=ordered.find(row=>!skipped.includes(row.id));
  function choose(basket:Basket){if(current)correct(current.id,basket);}
  if(!queue.length && !open)return null;
  const choices:{basket:Basket;name:"regularShort"|"surprisesShort"|"everydayShort";line:"regularLine"|"surprisesLine"|"everydayLine";dot:string}[]=[
    {basket:"mandatory_regular",name:"regularShort",line:"regularLine",dot:"bg-basket-regular"},
    {basket:"mandatory_irregular",name:"surprisesShort",line:"surprisesLine",dot:"bg-basket-surprises"},
    {basket:"everyday",name:"everydayShort",line:"everydayLine",dot:"bg-basket-everyday"},
  ];
  return <>
    {variant==="hero"
      ? <Button type="button" className="self-start" onClick={()=>{setSkipped([]);setOpen(true);}}>{t("reviewN",{count:count??queue.length})}</Button>
      : <Button type="button" variant="outline" size="chip" className="shrink-0" onClick={()=>{setSkipped([]);setOpen(true);}}>{t("reviewAction")}</Button>}
    <Drawer open={open} onOpenChange={setOpen}><DrawerContent>
      <DrawerHeader><DrawerTitle>{t("reviewTitle")}</DrawerTitle><DrawerDescription>{t("correctionsLocal")}</DrawerDescription></DrawerHeader>
      <DrawerBody className="space-y-4">{current ? <>
        <div className="space-y-1 rounded-2xl bg-tile-grey p-4"><p className="wrap-anywhere font-semibold">{current.merchant}</p><p className="text-caption tabular-nums text-ink-2">{date(current.booked_on)} · {signedMoney(current.amount_minor)}</p></div>
        <div className="grid gap-3">{choices.map(choice=><Button key={choice.basket} variant="outline" className="h-auto min-h-14 justify-start gap-3 rounded-2xl px-4 py-3 text-left" onClick={()=>choose(choice.basket)}><span className={`size-3 shrink-0 rounded-full ${choice.dot}`} aria-hidden="true"/><span className="min-w-0"><span className="block font-semibold">{t(choice.name)}</span><span className="block whitespace-normal text-caption font-normal text-ink-2">{t(choice.line)}</span></span></Button>)}
          <Button variant="ghost" onClick={()=>setSkipped(previous=>[...previous,current.id])}>{t("notSure")}</Button></div>
      </> : <p className="text-sm text-ink-2">{t("reviewDone")}</p>}</DrawerBody>
      <DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter>
    </DrawerContent></Drawer>
  </>;
}
