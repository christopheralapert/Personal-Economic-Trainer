"use client";
import {useState} from "react";
import {CircleHelp} from "lucide-react";
import {useMoneyData} from "@/lib/money-data-context";
import {useCopy} from "@/i18n/context";
import {date,signedMoney} from "@/lib/format";
import type {Basket} from "@/engine";
import {Button} from "./ui/button";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "./ui/drawer";
export function ReviewQueue() {
 const {queue,correct}=useMoneyData(),{t}=useCopy(),[open,setOpen]=useState(false),[skipped,setSkipped]=useState<string[]>([]),current=queue.find(row=>!skipped.includes(row.id));
 function choose(basket:Basket){if(current)correct(current.id,basket);}
 if(!queue.length && !open)return null;
 return <><Button type="button" variant="outline" size="chip" className="max-w-full" onClick={()=>{setSkipped([]);setOpen(true);}}><CircleHelp className="size-5"/>{t("reviewCount",{count:queue.length})}</Button><Drawer open={open} onOpenChange={setOpen}><DrawerContent><DrawerHeader><DrawerTitle>{t("reviewTitle")}</DrawerTitle><DrawerDescription>{t("correctionsLocal")}</DrawerDescription></DrawerHeader>{current ? <div className="max-h-sheet space-y-4 overflow-y-auto px-4"><div className="space-y-1"><p className="wrap-anywhere font-semibold">{current.merchant}</p><p className="text-caption text-ink-2">{date(current.booked_on)} · {signedMoney(current.amount_minor)}</p></div><div className="grid gap-3"><Button className="h-auto min-h-14" variant="outline" onClick={()=>choose("mandatory_regular")}>{t("regularPlain")}</Button><Button className="h-auto min-h-14" variant="outline" onClick={()=>choose("mandatory_irregular")}>{t("surpriseExpense")}</Button><Button className="h-auto min-h-14" variant="outline" onClick={()=>choose("everyday")}>{t("everyday")}</Button><Button variant="ghost" onClick={()=>setSkipped(previous=>[...previous,current.id])}>{t("notSure")}</Button></div></div> : <p className="px-4 text-sm text-ink-2">{t("reviewDone")}</p>}<DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer></>;
}
