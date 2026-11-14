"use client";
import type {ReactNode} from "react";
import {ChevronRight} from "lucide-react";
import {useCopy} from "@/i18n/context";
import {Button} from "./ui/button";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose,DrawerBody} from "./ui/drawer";

/** A titled group of rows on a hairline-separated surface. */
export function SettingsGroup({title,children,note}:{title:string;children:ReactNode;note?:ReactNode}) {
  return <section className="space-y-2" aria-label={title}>
    <h3 className="px-1 text-sm font-semibold text-ink-2">{title}</h3>
    <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">{children}</div>
    {note && <p className="px-1 text-caption text-ink-2">{note}</p>}
  </section>;
}

const rowClass="flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left text-ink no-underline transition-colors hover:bg-tile-grey focus-visible:bg-tile-grey";
function RowText({label,value,chevron=true}:{label:string;value?:ReactNode;chevron?:boolean}) {
  return <><span className="min-w-0 flex-1"><span className="block text-base">{label}</span>{value!==undefined && value!==null && <span className="block text-caption text-ink-2">{value}</span>}</span>{chevron && <ChevronRight className="size-4 shrink-0 text-ink-2" aria-hidden="true"/>}</>;
}

/** Row that runs an action, follows a link, or (with neither) simply states a value. */
export function SettingsRow({label,value,onClick,href}:{label:string;value?:ReactNode;onClick?:()=>void;href?:string}) {
  if(href) return <a className={rowClass} href={href}><RowText label={label} value={value}/></a>;
  if(onClick) return <button type="button" className={rowClass} onClick={onClick}><RowText label={label} value={value}/></button>;
  return <div className="flex min-h-14 w-full items-center gap-3 px-4 py-3"><RowText label={label} value={value} chevron={false}/></div>;
}

/** Row whose detail opens in one bottom sheet. */
export function SettingsSheetRow({label,value,title,description,children,footer}:{label:string;value?:ReactNode;title?:string;description?:string;children:ReactNode;footer?:ReactNode}) {
  const {t}=useCopy();
  return <Drawer><DrawerTrigger asChild><button type="button" className={rowClass}><RowText label={label} value={value}/></button></DrawerTrigger>
    <DrawerContent><DrawerHeader><DrawerTitle>{title??label}</DrawerTitle>{description ? <DrawerDescription>{description}</DrawerDescription> : <DrawerDescription className="sr-only">{label}</DrawerDescription>}</DrawerHeader>
      <DrawerBody className="space-y-4">{children}</DrawerBody>
      <DrawerFooter>{footer}<DrawerClose asChild><Button>{t("done")}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>;
}
