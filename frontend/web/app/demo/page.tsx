import {MoneyCoach} from "@/components/money-coach";
import {Preferences} from "@/i18n/context";
import {MoneyDataProvider} from "@/lib/money-data-context";
import {PlanningProvider} from "@/lib/planning-context";
import {InstallProvider} from "@/pwa/install-context";
import {DemoEntry} from '@web/components/demo-entry';
export const dynamic="force-dynamic";
export default async function DemoPage({searchParams}:{searchParams:Promise<{dataset?:string}>}){const params=await searchParams;return params.dataset?<InstallProvider><Preferences><MoneyDataProvider defaultDataset="organizer1"><PlanningProvider><MoneyCoach embeddedDemo onlineCoachEnabled={process.env.MONEY_COACH_PUBLIC_GEMINI_ENABLED==="true" && Boolean(process.env.GEMINI_API_KEY)}/></PlanningProvider></MoneyDataProvider></Preferences></InstallProvider>:<Preferences><DemoEntry/></Preferences>;}
