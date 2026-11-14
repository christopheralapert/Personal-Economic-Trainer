"use client";
import Link from "next/link";
import {useCopy} from "@/i18n/context";
import {Button} from "@/components/ui/button";

export default function NotFound() {
  const {t}=useCopy();
  return <main className="mx-auto min-h-dvh max-w-app space-y-6 bg-surface px-4 py-8"><h1 className="text-xl font-bold">{t("pageMissing")}</h1><p className="text-base leading-relaxed text-ink-2">{t("pageMissingHelp")}</p><Button asChild><Link href="/">{t("overview")}</Link></Button></main>;
}
