"use client";
import {useCopy} from '@/i18n/context';
import {Button} from '@/components/ui/button';
import {ArrowRight,FileUp,MessageCircle,Layers,SlidersHorizontal,ShieldCheck} from 'lucide-react';
import {demoEntryCopy} from '../i18n/demo-entry';
/** The challenge's four example questions, each opening the sample data with the question ready. */
const questions=["qTaxi","qProfile","qSafe","qWhatif"] as const;
export function DemoEntry({embedded=false}:{embedded?:boolean}){
 const {locale,t}=useCopy(),c=demoEntryCopy[locale];
 const ask=(question:string)=>`/demo?${new URLSearchParams({dataset:'organizer1',tab:'coach',question})}`;
 const features=[[Layers,"landingBaskets","landingBasketsNote"],[SlidersHorizontal,"landingWhatIf","landingWhatIfNote"],[ShieldCheck,"landingPrivate","landingPrivateNote"]] as const;
 const content=<section className="space-y-8 py-6">
  <div className="space-y-3"><h1 className="text-3xl font-semibold leading-tight">{c.title}</h1><p className="text-base text-ink-2">{c.intro}</p></div>
  <div className="space-y-5">
   <Button asChild className="h-auto min-h-14 w-full justify-between gap-3 px-4"><a href="/demo/import"><span className="flex items-center gap-3"><FileUp aria-hidden="true" className="size-5 shrink-0"/>{c.practice}</span><ArrowRight aria-hidden="true" className="size-5 shrink-0"/></a></Button>
   <div className="space-y-2"><Button asChild variant="outline" className="h-auto min-h-14 w-full justify-between gap-3 px-4"><a href="/demo?dataset=organizer1">{c.sample}<ArrowRight aria-hidden="true" className="size-5 shrink-0"/></a></Button><p className="text-sm text-ink-2">{c.sampleNote}</p></div>
  </div>
  <section aria-labelledby="landing-ask" className="space-y-3">
   <div className="space-y-1"><h2 id="landing-ask" className="flex items-center gap-2 text-lg font-semibold"><MessageCircle aria-hidden="true" className="size-5 shrink-0 text-brand"/>{t("landingAsk")}</h2><p className="text-sm text-ink-2">{t("landingAskNote")}</p></div>
   <ul className="flex flex-wrap gap-2">{questions.map(key=><li key={key}><a href={ask(t(key))} className="inline-flex min-h-11 items-center rounded-full border border-line bg-surface px-4 py-2 text-sm font-medium text-ink transition-colors hover:border-brand hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand">{t(key)}</a></li>)}</ul>
  </section>
  <ul className="divide-y divide-line rounded-xl border border-line bg-surface">{features.map(([Icon,title,note])=><li key={title} className="flex gap-3 p-4"><span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand"><Icon className="size-5"/></span><span className="min-w-0 space-y-1"><span className="block font-semibold">{t(title)}</span><span className="block text-sm text-ink-2">{t(note)}</span></span></li>)}</ul>
 </section>;
 return embedded?content:<div className="mx-auto min-h-dvh w-full max-w-app bg-canvas px-4 pt-safe"><header className="flex min-h-14 items-center"><a href="/demo" className="text-xl font-semibold text-ink">Money Coach</a></header><main id="main" tabIndex={-1}>{content}</main></div>;
}
