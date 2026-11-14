"use client";
import {ArrowRight} from "lucide-react";
import {useCopy,type Key} from "@/i18n/context";
import {Button} from "@/components/ui/button";
export type Concept="fund"|"cashflow"|"habit"|"basketConcept"|"safeConcept"|"savingConcept"|"regular"|"irregular"|"everyday";
export function ConceptCard({concept,onAsk}:{concept:Concept;onAsk?:(question:string)=>void}) {
  const {t}=useCopy();const question=concept==="savingConcept" ? "qSave" : concept==="habit" ? "qWhatif" : ["basketConcept","regular","irregular","everyday"].includes(concept) ? "qBaskets" : "qSafe";
  return <section className="space-y-3 border-b border-line py-6"><h2 className="text-xl font-bold">{t(concept)}</h2><p className="text-sm leading-relaxed text-ink-2">{t(`${concept}Text` as Key)}</p><Button variant="link" onClick={()=>onAsk?.(t(question))}>{t("showData")}<ArrowRight className="size-5"/></Button></section>;
}
