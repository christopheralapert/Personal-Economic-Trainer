"use client";
import {CircleAlert} from "lucide-react";
import {useCopy} from "@/i18n/context";
import {Button} from "./button";
import {cn} from "@/lib/utils";

/** Plain-language error with one retry action. A raw code, when known, is only a small technical line. */
export function InlineError({message,onRetry,code,className}:{message:string;onRetry?:()=>void;code?:string|null;className?:string}) {
  const {t}=useCopy();
  return <div role="alert" className={cn("flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4",className)}>
    <p className="flex items-start gap-3 text-sm text-ink"><CircleAlert className="mt-0.5 size-5 shrink-0 text-warn" aria-hidden="true"/><span>{message}</span></p>
    {onRetry && <Button variant="outline" size="chip" className="self-start" onClick={onRetry}>{t("retry")}</Button>}
    {code && <p className="text-caption text-ink-2">{t("technicalDetail",{code})}</p>}
  </div>;
}
