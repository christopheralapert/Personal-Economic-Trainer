"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {useRef,useState} from "react";
import type {components} from "@contracts";
import {useCopy,categoryLabel} from "@/i18n/context";
import {Button} from "@/components/ui/button";
import {RadioGroup,RadioGroupItem} from "@/components/ui/radio-group";
import {Drawer,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter} from "@/components/ui/drawer";
import {reviewCopy} from "../i18n/classification-review";
import {aborted,type PrivateRequest} from "./private-session";
import {euros} from "./plan-format";
import {classificationCopy} from "./statement-classification";
type Schema=components["schemas"];
type Review=Schema["ClassificationReviewV1"];
const categories=["taxi","dining","groceries","housing","repairs","coffee","other","utilities","phone","insurance","transport","health","pharmacy","home_tech","lifestyle","entertainment","travel"] as const;
export function ClassificationSheet({row,version,request,close,saved}:{row:Schema["LedgerRowV1"];version:number;request:PrivateRequest;close:()=>void;saved:()=>void}){
 const {locale,t}=useCopy(),c=reviewCopy[copyLocale(locale)];
 const [flow,setFlow]=useState<Review["economic_flow"]>(row.economic_flow as Review["economic_flow"]);
 const [category,setCategory]=useState<NonNullable<Review["category"]>>(categories.includes(row.category as typeof categories[number])?row.category as typeof categories[number]:"other");
 const [basket,setBasket]=useState<Review["basket"]>(row.basket as Review["basket"]);
 const [busy,setBusy]=useState(false),[error,setError]=useState("");const lock=useRef(false);
 const [remember,setRemember]=useState(false);
 const consumption=flow==="expense"||flow==="refund";
 const flows:Review["economic_flow"][]=[...(row.amount_minor<0?["expense" as const]:row.amount_minor>0?["income" as const,"refund" as const]:[]),"internal_transfer","liability_settlement","unknown"];
 async function save(){if(lock.current)return;lock.current=true;setBusy(true);setError("");try{
  await request<Schema["ClassificationResultV1"]>(`ledger/transactions/${row.id}/classification`,{expected_data_version:version,economic_flow:flow,category:consumption?category:null,basket:consumption?basket:"unresolved",...(consumption&&remember?{remember_merchant:true}:{})});
  window.dispatchEvent(new Event("moneylens-data-changed"));saved();
 }catch(reason){if(!aborted(reason))setError(c.failed);}finally{lock.current=false;setBusy(false);}}
 return <Drawer open onOpenChange={open=>{if(!open&&!busy)close();}}><DrawerContent><DrawerHeader><DrawerTitle>{c.edit}</DrawerTitle><DrawerDescription>{row.merchant} · {euros(row.amount_minor)}</DrawerDescription></DrawerHeader><div className="max-h-sheet space-y-4 overflow-y-auto px-4"><fieldset disabled={busy} className="space-y-3"><legend className="mb-2 text-sm font-semibold">{c.purpose}</legend><RadioGroup value={flow} onValueChange={value=>setFlow(value as Review["economic_flow"])}>{flows.map(value=><label key={value} className="flex min-h-12 items-center gap-3 text-sm"><RadioGroupItem value={value}/>{c[value]}</label>)}</RadioGroup></fieldset>{consumption&&<div className="grid gap-3"><label className="space-y-1 text-sm">{c.category}<select aria-label={c.category} className="min-h-12 w-full rounded-xl border border-input bg-surface px-3 text-ink" value={category} disabled={busy} onChange={e=>setCategory(e.target.value as NonNullable<Review["category"]>)}>{categories.map(value=><option key={value} value={value}>{value==="pharmacy"?c.pharmacy:categoryLabel(value,t)}</option>)}</select></label><label className="space-y-1 text-sm">{c.basket}<select aria-label={c.basket} className="min-h-12 w-full rounded-xl border border-input bg-surface px-3 text-ink" value={basket} disabled={busy} onChange={e=>setBasket(e.target.value as Review["basket"])}><option value="unresolved">{c.basket}</option>{(["mandatory_regular","mandatory_irregular","everyday"] as const).map(value=><option key={value} value={value}>{c[value]}</option>)}</select></label><label className="flex min-h-12 items-center gap-3 text-sm"><input type="checkbox" checked={remember} disabled={busy} onChange={event=>setRemember(event.target.checked)}/>{classificationCopy[copyLocale(locale)].remember}</label></div>}<p className="text-caption text-ink-2">{c.source}</p>{error&&<p role="alert" className="text-sm text-neg">{error}</p>}</div><DrawerFooter><Button disabled={busy||(consumption&&basket==="unresolved")} onClick={()=>void save()}>{busy?c.saving:c.save}</Button><Button variant="ghost" disabled={busy} onClick={close}>{c.cancel}</Button></DrawerFooter></DrawerContent></Drawer>;
}
