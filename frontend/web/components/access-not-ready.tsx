"use client";
import {copyLocale} from "@/i18n/dictionaries";
import {Button} from "@/components/ui/button";
import {useCopy} from "@/i18n/context";
const copy={
 en:{title:"Your Money Coach access hasn’t been set up yet.",note:"Ask your inviter to set up access, or explore the demo now.",demo:"Try the demo",another:"Sign in with another account"},
 fi:{title:"Money Coach -käyttöoikeuttasi ei ole vielä määritetty.",note:"Pyydä kutsujalta käyttöoikeus tai tutustu demoon nyt.",demo:"Kokeile demoa",another:"Kirjaudu toisella tilillä"},
 et:{title:"Sinu Money Coachi ligipääsu pole veel seadistatud.",note:"Palu kutsujal ligipääs seadistada või tutvu kohe demoga.",demo:"Proovi demot",another:"Logi sisse teise kontoga"}
} as const;
export function AccessNotReady(){const {locale}=useCopy(),c=copy[copyLocale(locale)];return <div className="mx-auto min-h-dvh max-w-app bg-canvas px-4 pt-safe"><header className="flex min-h-14 items-center"><a href="/" className="text-xl font-semibold text-ink">Money Coach</a></header><main id="main" className="py-6"><section className="space-y-6 rounded-3xl border border-line bg-surface p-6"><div className="space-y-3"><h1 className="text-xl font-semibold">{c.title}</h1><p className="text-sm text-ink-2">{c.note}</p></div><div className="grid gap-3"><Button asChild className="w-full"><a href="/demo?dataset=organizer1">{c.demo}</a></Button><Button asChild variant="outline" className="w-full"><a href="/api/v1/auth/login?prompt=login">{c.another}</a></Button></div></section></main></div>;}
