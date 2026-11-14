"use client";
import {useId,useEffect,useState} from "react";
import {Dialog as DialogPrimitive} from "radix-ui";
import {useMoneyData} from "@/lib/money-data-context";
import {useCopy} from "@/i18n/context";
import {datasetKeys,datasetKeySchema,organizerManifest} from "@/engine/datasets";
import {RadioGroup,RadioGroupItem} from "./ui/radio-group";
import {Button} from "./ui/button";
import {Drawer,DrawerContent,DrawerTitle,DrawerDescription,DrawerHeader,DrawerFooter,DrawerClose} from "./ui/drawer";
const tagKeys={salaried:"personaSalaried",housing:"personaHousing",frequent_taxis:"personaTaxi",dining_heavy:"personaDining",investment:"personaInvestment",mortgage_link:"personaMortgage",multi_account:"personaMulti"} as const;
export function DatasetPicker(){
 const {dataset,selectDataset}=useMoneyData(),{t}=useCopy(),id=useId(),[open,setOpen]=useState(false),[desktop,setDesktop]=useState(false);
 useEffect(()=>{const query=matchMedia("(min-width: 48rem)"),update=()=>setDesktop(query.matches);update();query.addEventListener("change",update);return()=>query.removeEventListener("change",update);},[]);
 const title=t("personaChoose"),description=t("peerSynthetic");
 const choices=<RadioGroup value={dataset} aria-label={t("demoDataset")} className="grid gap-3 md:grid-cols-2" onValueChange={value=>{selectDataset(datasetKeySchema.parse(value));setOpen(false);}}>{datasetKeys.map(key=>{
  const entry=organizerManifest[key],legacy=key==="organizer1" ? t("organizerOne") : key==="organizer2" ? t("organizerTwo") : key==="organizer3" ? t("organizerThree") : undefined;
  const label=entry ? t("personaSelected",{number:key.replace("organizer","")}) : t(key==="starter" ? "starterDataset" : "extendedDataset");
  return <label key={key} htmlFor={`${id}-${key}`} className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border p-4 ${dataset===key ? "border-brand bg-muted" : "border-line bg-surface"}`}><RadioGroupItem value={key} id={`${id}-${key}`} aria-label={legacy??label}/><span className="min-w-0 space-y-2"><span className="block font-semibold">{label}</span>{entry && <><span className="block text-sm">{[...entry.tags].sort((a,b)=>["frequent_taxis","dining_heavy","mortgage_link","multi_account","investment","salaried","housing"].indexOf(a)-["frequent_taxis","dining_heavy","mortgage_link","multi_account","investment","salaried","housing"].indexOf(b)).slice(0,2).map(tag=>t(tagKeys[tag])).join(" · ")}</span><span className="block text-sm text-ink-2">{t("peerAge",{band:entry.age_band})} · {t("peerArea",{prefix:entry.postal_prefix})}</span><span className="block text-caption text-ink-2">{t("personaHistory",{months:entry.complete_months,rows:entry.rows})}</span></>}</span></label>;
 })}</RadioGroup>;
 return <section className="space-y-3"><h3 className="font-semibold">{t("demoDataset")}</h3><Button variant="outline" className="h-auto min-h-12 max-w-full whitespace-normal" onClick={()=>setOpen(true)}>{title}</Button>{desktop ? <DialogPrimitive.Root open={open} onOpenChange={setOpen}><DialogPrimitive.Portal><DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50"/><div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-6"><DialogPrimitive.Content className="pointer-events-auto flex max-h-sheet w-full max-w-3xl flex-col gap-4 rounded-3xl border border-line bg-surface p-6"><DialogPrimitive.Title className="text-xl font-semibold">{title}</DialogPrimitive.Title><DialogPrimitive.Description className="text-sm text-ink-2">{description}</DialogPrimitive.Description><div className="min-h-0 overflow-y-auto">{choices}</div><DialogPrimitive.Close asChild><Button>{t("done")}</Button></DialogPrimitive.Close></DialogPrimitive.Content></div></DialogPrimitive.Portal></DialogPrimitive.Root> : <Drawer open={open} onOpenChange={setOpen}><DrawerContent><DrawerHeader><DrawerTitle>{title}</DrawerTitle><DrawerDescription>{description}</DrawerDescription></DrawerHeader><div className="min-h-0 overflow-y-auto px-4">{choices}</div><DrawerFooter><DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>}</section>;
}
