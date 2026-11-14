"use client";
import Link from "next/link";
import {useCopy} from "@/i18n/context";
import {Button} from "@/components/ui/button";

export default function ErrorView({retry}:{error:unknown;retry:()=>void}) {
  const {t}=useCopy();
  return <main className="mx-auto min-h-dvh max-w-app space-y-6 bg-surface px-4 py-8"><h1 className="text-xl font-bold">{t("pageFailed")}</h1><p role="alert" className="text-base leading-relaxed text-ink-2">{t("pageRecovery")}</p><div className="flex flex-wrap gap-3"><Button onClick={retry}>{t("retry")}</Button><Button asChild variant="outline"><Link href="/">{t("overview")}</Link></Button></div></main>;
}
