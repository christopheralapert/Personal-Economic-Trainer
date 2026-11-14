"use client";
import {Download,ChevronDown} from "lucide-react";
import {useInstall} from "@/pwa/install-context";
import {useCopy} from "@/i18n/context";
import {Button} from "./ui/button";
import {Collapsible,CollapsibleContent,CollapsibleTrigger} from "./ui/collapsible";
const messages={unavailable:"installUnavailable",available:"installAvailable",prompting:"installPrompting",dismissed:"installDismissed",accepted:"installAccepted",installed:"installDone",error:"installFailed"} as const;
export function InstallApp() {
  const {t}=useCopy(),{status,available,install}=useInstall();
  return <section aria-labelledby="install-title" className="space-y-3 border-t border-line pt-6">
    <h3 id="install-title" className="font-semibold">{t("installTitle")}</h3>
    <p role="status" className="text-sm leading-relaxed text-ink-2">{t(messages[status])}</p>
    {(available || status==="prompting") && <Button disabled={!available || status==="prompting"} onClick={()=>void install()}><Download aria-hidden="true" className="size-5"/>{t("installAction")}</Button>}
    <Collapsible><CollapsibleTrigger asChild><Button variant="outline">{t("installHelp")}<ChevronDown aria-hidden="true" className="size-5"/></Button></CollapsibleTrigger><CollapsibleContent className="space-y-3 pt-3"><p className="text-sm leading-relaxed text-ink-2">{t("installInstructions")}</p><p className="text-caption leading-relaxed text-ink-2">{t("installPrivacy")}</p></CollapsibleContent></Collapsible>
  </section>;
}
