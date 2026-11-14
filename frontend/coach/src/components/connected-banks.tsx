"use client";
import {sourceDate} from "@/engine/source-date";
import {useMoneyData} from "@/lib/money-data-context";
import {Landmark} from "lucide-react";
import {bankSummaries} from "@/engine";
import {useCopy} from "@/i18n/context";
import {date} from "@/lib/format";
import {MoneyAmount} from "./gen/money-amount";
import {Badge} from "./ui/badge";

export function ConnectedBanks() {
  const {data}=useMoneyData(),{t}=useCopy(),banks=bankSummaries(data),snapshot=sourceDate(data.as_of);
  return <section aria-labelledby="connected-banks-title" className="space-y-3 border-t border-line pt-6">
    <h3 id="connected-banks-title" className="font-semibold">{t("connectedBanks")}</h3>
    <p className="text-sm leading-relaxed text-ink-2">{t("demoBanksNote")}</p>
    <p className="text-caption text-ink-2">{t("bankBalanceBasis",{date:date(snapshot)})}</p>
    <ul>{banks.map(bank=><li key={bank.id} className="flex min-h-14 items-start gap-3 border-b border-line py-4 last:border-b-0">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tile-grey text-brand"><Landmark aria-hidden="true" className="size-5"/></span>
      <div className="min-w-0 flex-1 space-y-1"><p className="wrap-anywhere text-base font-medium">{bank.name ?? t("unnamedDemoBank")}</p><p className="text-caption text-ink-2">{t(bank.accountCount===1 ? "demoAccountOne" : "demoAccountMany",{count:bank.accountCount})}</p><Badge variant="secondary">{t("demoOnly")}</Badge></div>
      {bank.balance!==null && <p className="shrink-0 text-right text-base font-semibold"><MoneyAmount minor={bank.balance}/></p>}
    </li>)}</ul>
  </section>;
}
