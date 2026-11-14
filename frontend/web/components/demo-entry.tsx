"use client";
import {useCopy} from '@/i18n/context';
import {Button} from '@/components/ui/button';
import {ArrowRight,FileUp} from 'lucide-react';
import {demoEntryCopy} from '../i18n/demo-entry';
export function DemoEntry({embedded=false}:{embedded?:boolean}){
 const {locale}=useCopy(),c=demoEntryCopy[locale];
 const content=<section className="space-y-8 py-6">
  <div className="space-y-3"><h1 className="text-3xl font-semibold leading-tight">{c.title}</h1><p className="text-base text-ink-2">{c.intro}</p></div>
  <div className="space-y-5">
   <Button asChild className="h-auto min-h-14 w-full justify-between gap-3 px-4"><a href="/demo/import"><span className="flex items-center gap-3"><FileUp aria-hidden="true" className="size-5 shrink-0"/>{c.practice}</span><ArrowRight aria-hidden="true" className="size-5 shrink-0"/></a></Button>
   <div className="space-y-2"><Button asChild variant="outline" className="h-auto min-h-14 w-full justify-between gap-3 px-4"><a href="/demo?dataset=organizer1">{c.sample}<ArrowRight aria-hidden="true" className="size-5 shrink-0"/></a></Button><p className="text-sm text-ink-2">{c.sampleNote}</p></div>
  </div>
 </section>;
 return embedded?content:<div className="mx-auto min-h-dvh w-full max-w-app bg-canvas px-4 pt-safe"><header className="flex min-h-14 items-center"><a href="/demo" className="text-xl font-semibold text-ink">Money Coach</a></header><main id="main" tabIndex={-1}>{content}</main></div>;
}
