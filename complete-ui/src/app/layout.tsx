import type {Metadata,Viewport} from "next";
import {Preferences} from "@/i18n/context";
import {RegisterWorker} from "@/pwa/register";
import {InstallProvider} from "@/pwa/install-context";
import {MoneyDataProvider} from "@/lib/money-data-context";
import {PlanningProvider} from "@/lib/planning-context";
import {AppShell} from "@/components/app-shell";
import "./globals.css";
export const metadata:Metadata={title:"Money Coach",description:"Explore a synthetic financial snapshot through visual conversations.",manifest:"/manifest.webmanifest",appleWebApp:{capable:true,title:"Money Coach"},icons:{apple:"/apple-touch-icon.png"}};
export const viewport:Viewport={width:"device-width",initialScale:1,viewportFit:"cover",themeColor:"#00814a"};
export default function RootLayout({children}:{children:React.ReactNode}) {
  return <html lang="en"><body><InstallProvider><RegisterWorker/><Preferences><MoneyDataProvider><PlanningProvider><AppShell>{children}</AppShell></PlanningProvider></MoneyDataProvider></Preferences></InstallProvider></body></html>;
}
