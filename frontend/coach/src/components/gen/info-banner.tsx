"use client";
import {Info,ChevronRight} from "lucide-react";
import {useCopy} from "@/i18n/context";
export function InfoBanner({onClick}:{onClick?:()=>void}) {
  const {t}=useCopy();return <button className="flex min-h-14 w-full items-center gap-3 rounded-3xl bg-tile-info p-4 text-left text-sm" onClick={onClick}><Info className="size-5 shrink-0" aria-hidden="true"/><span className="flex-1">{t("tip")}</span><ChevronRight className="size-5 shrink-0" aria-hidden="true"/></button>;
}
