"use client";
import {useId,useRef,useState,type DragEvent} from 'react';
import {FileUp} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {useCopy} from '@/i18n/context';
import {demoEntryCopy} from '../i18n/demo-entry';

export function DemoFileUpload({busy,onFiles,onSample}:{busy:boolean;onFiles:(files:File[])=>void;onSample:()=>void}){
 const {locale}=useCopy(),c=demoEntryCopy[locale],input=useRef<HTMLInputElement>(null),hint=useId();
 const [dragging,setDragging]=useState(false),depth=useRef(0);
 function drag(event:DragEvent<HTMLDivElement>){
  event.preventDefault();
  if(busy)return;
  event.dataTransfer.dropEffect='copy';
 }
 return <div className="space-y-3">
  <div data-demo-upload data-dragging={dragging&&!busy} className="grid justify-items-center gap-3 rounded-2xl border-2 border-dashed border-line bg-surface px-4 py-7 text-center data-[dragging=true]:border-primary data-[dragging=true]:bg-accent"
   onDragEnter={event=>{drag(event);depth.current++;if(!busy)setDragging(true);}}
   onDragOver={drag}
   onDragLeave={event=>{event.preventDefault();depth.current=Math.max(0,depth.current-1);if(!depth.current)setDragging(false);}}
   onDrop={event=>{event.preventDefault();depth.current=0;setDragging(false);if(!busy)onFiles(Array.from(event.dataTransfer.files));}}>
   <FileUp aria-hidden="true" className="size-7 text-primary"/>
   <p id={hint} className="text-sm text-ink-2">{c.dropHint}</p>
   <input ref={input} type="file" multiple accept=".csv" aria-label={c.chooseFiles} aria-describedby={hint} className="hidden" disabled={busy}
    onChange={event=>{onFiles(Array.from(event.target.files??[]));event.target.value='';}}/>
   <Button type="button" disabled={busy} aria-describedby={hint} onClick={()=>input.current?.click()}>{c.chooseFiles}</Button>
   <p className="text-caption text-ink-2">auto-taxis.csv · CSV</p>
  </div>
  <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={onSample}>{c.useSample}</Button>
 </div>;
}
