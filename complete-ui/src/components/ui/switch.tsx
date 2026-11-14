"use client";
import * as React from "react";
import {cva} from "class-variance-authority";
import {Switch as SwitchPrimitive} from "radix-ui";
import {cn} from "@/lib/utils";
// Generated with shadcn CLI; sizes normalized to the project's Tailwind scale.
const track=cva("peer inline-flex shrink-0 items-center rounded-full p-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand data-[state=unchecked]:bg-line",{variants:{size:{default:"h-8 w-14",sm:"h-6 w-10"}},defaultVariants:{size:"default"}});
const thumb=cva("pointer-events-none block rounded-full bg-ink-2 transition-transform data-[state=checked]:bg-brand-ink data-[state=unchecked]:translate-x-0",{variants:{size:{default:"size-6 data-[state=checked]:translate-x-6",sm:"size-4 data-[state=checked]:translate-x-4"}},defaultVariants:{size:"default"}});
function Switch({className,size="default",...props}:React.ComponentProps<typeof SwitchPrimitive.Root>&{size?:"sm"|"default"}) {
 return <SwitchPrimitive.Root data-slot="switch" data-size={size} className={cn(track({size}),className)} {...props}><SwitchPrimitive.Thumb data-slot="switch-thumb" className={thumb({size})}/></SwitchPrimitive.Root>;
}
export {Switch};
