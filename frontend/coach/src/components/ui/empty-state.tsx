import type {LucideIcon} from "lucide-react";
import type {ReactNode} from "react";
import {cn} from "@/lib/utils";

/** Calm empty state: icon, title, one line, at most one action. Never a dead end. */
export function EmptyState({icon:Icon,title,children,action,className}:{icon:LucideIcon;title:string;children?:ReactNode;action?:ReactNode;className?:string}) {
  return <div className={cn("flex flex-col items-center gap-3 px-4 py-8 text-center",className)}>
    <span className="flex size-12 items-center justify-center rounded-full bg-brand-tint text-active-ink" aria-hidden="true"><Icon className="size-6"/></span>
    <div className="space-y-1"><h3 className="text-base font-semibold">{title}</h3>{children && <p className="text-sm text-ink-2">{children}</p>}</div>
    {action}
  </div>;
}
