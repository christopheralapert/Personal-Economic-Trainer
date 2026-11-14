export function TickBar({parts,caption,captionTone="muted"}:{parts:{value:number;className:string}[];caption:string;captionTone?:"ink"|"muted"}) {
  const total=parts.reduce((s,p)=>s+Math.max(0,p.value),0);
  return <div className={captionTone==="ink" ? "space-y-1" : "space-y-3"}><div className="flex gap-tick" aria-hidden="true">{Array.from({length:40},(_,i)=>{
    let sofar=0;const found=parts.find(p=>{sofar+=Math.max(0,p.value);return total>0 && (i+.5)/40<=sofar/total;});
    return <span key={i} className={`${captionTone==="ink" ? "h-5" : "h-7"} min-w-0 flex-1 rounded-sm ${found?.className ?? "bg-line"}`}/>;
  })}</div>{caption && <p className={captionTone==="ink" ? "text-sm text-ink" : "text-caption text-ink-2"}>{caption}</p>}</div>;
}
