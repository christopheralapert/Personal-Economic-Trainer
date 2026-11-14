/** Proportional bar: one segment per part, widths equal to shares (small shares keep a minimum visible width).
 * Decorative unless `label` is given; callers always show the same values as text next to it. */
export function TickBar({parts,caption,captionTone="muted",label}:{parts:{value:number;className:string}[];caption:string;captionTone?:"ink"|"muted";label?:string}) {
  const visible=parts.filter(part=>part.value>0);
  return <div className="space-y-2">
    <div className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-line" {...(label ? {role:"img","aria-label":label} : {"aria-hidden":true})}>
      {visible.map((part,index)=><span key={index} className={`h-full min-w-basket-min ${part.className}`} style={{flexGrow:part.value,flexBasis:0}}/>)}
    </div>
    {caption && <p className={captionTone==="ink" ? "text-sm text-ink" : "text-caption text-ink-2"}>{caption}</p>}
  </div>;
}
