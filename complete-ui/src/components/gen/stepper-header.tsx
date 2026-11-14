"use client";
import {ArrowLeft} from "lucide-react";
import {useCopy} from "@/i18n/context";
import {Button} from "@/components/ui/button";
export function StepperHeader({step,onBack,title}:{step:1|2|3;onBack?:()=>void;title?:string}) {
  const {t}=useCopy();return <header className="space-y-5"><div className="flex items-center gap-3">{onBack && <Button type="button" variant="secondary" size="icon" onClick={onBack} aria-label={t("back")}><ArrowLeft className="size-5"/></Button>}<div className="min-w-0"><h2 className="text-xl font-bold">{title??t("goal")}</h2><p className="text-sm text-ink-2" role="status">{t("goalStep",{step})}</p></div></div><div className="flex gap-2" aria-hidden="true">{[1,2,3].map(n=><span key={n} className={`h-1 flex-1 rounded-full ${n<=step ? "bg-ink" : "bg-line"}`}/>)}</div></header>;
}
