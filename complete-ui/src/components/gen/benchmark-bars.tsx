"use client";
import {useCopy,categoryLabel} from "@/i18n/context";
import {date,money} from "@/lib/format";
import {Progress} from "@/components/ui/progress";
import type {benchmark} from "@/engine";
export function BenchmarkBars({result}:{result:ReturnType<typeof benchmark>}) {
  const {t}=useCopy(),maximum=Math.max(result.you ?? 0,result.typical ?? 0,1);
  const through=new Date(Date.parse(result.period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10);
  return <section className="space-y-4"><h3 className="wrap-anywhere text-xl font-bold">{categoryLabel(result.category,t)}</h3><p className="text-caption text-ink-2">{t("period")}: <time dateTime={result.period.start}>{date(result.period.start)}</time> – <time dateTime={through}>{date(through)}</time></p><p className="text-sm font-semibold">{t("approx")}</p>{([["you",result.you],["typical",result.typical]] as const).map(([key,value])=><div className="space-y-2" key={key}><div className="flex flex-wrap justify-between gap-3 text-sm"><span>{t(key)}</span><strong>{value===null ? t("notAvailable") : money(value)}</strong></div>{value!==null && <Progress aria-label={t(key)} aria-valuetext={money(value)} value={Math.max(0,value)/maximum*100}/>}</div>)}<p className="text-caption text-ink-2">{result.reference ? t("benchmarkNote") : t("noBenchmark")}</p>{result.reference && <a href={result.reference.source} className="inline-flex min-h-12 items-center text-sm text-brand underline" target="_blank" rel="noreferrer">{t("source")} · {result.reference.year}</a>}</section>;
}
