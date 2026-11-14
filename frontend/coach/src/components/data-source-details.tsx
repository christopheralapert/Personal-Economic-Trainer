"use client";
import {sourceCopyKey} from "@/engine/datasets";
import {useMoneyData} from "@/lib/money-data-context";
import {sourceInventory} from "@/engine";
import {useCopy} from "@/i18n/context";
import {date} from "@/lib/format";

export function DataSourceDetails() {
  const {data,dataset}=useMoneyData(),{t}=useCopy(),source=sourceInventory(data);
  const fields=[
    [t("transactions"),source.count],
    [t("includedAccounts"),source.accounts],
    [t("recordedRange"),source.first && source.last ? `${date(source.first)} – ${date(source.last)}` : t("notAvailable")],
    [t("booked"),source.statuses.booked],
    [t("reserved"),source.statuses.pending],
    [t("reversed"),source.statuses.reversed],
    [t("sourceCalendar"),source.timezone],
  ] as const;
  return <section className="space-y-4 border-t border-line pt-5"><h3 className="font-semibold">{t("source")}</h3><p className="text-caption leading-relaxed text-ink-2">{t(sourceCopyKey(dataset))}</p><p className="text-caption leading-relaxed text-ink-2">{t("sourceSnapshot",{date:date(source.asOf)})}</p><dl className="divide-y divide-line">{fields.map(([label,value])=><div key={label} className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3"><dt className="text-sm text-ink-2">{label}</dt><dd className="wrap-anywhere text-right text-sm tabular-nums">{value}</dd></div>)}</dl><p className="text-caption leading-relaxed text-ink-2">{t("partial")}</p></section>;
}
