import {MoneyCoach} from "@/components/money-coach";
import {Preferences} from "@/i18n/context";
import {MoneyDataProvider} from "@/lib/money-data-context";
import {PlanningProvider} from "@/lib/planning-context";
import {InstallProvider} from "@/pwa/install-context";
export const dynamic="force-dynamic";
export default function DemoPage(){return <InstallProvider><Preferences><MoneyDataProvider defaultDataset="organizer1"><PlanningProvider><MoneyCoach embeddedDemo/></PlanningProvider></MoneyDataProvider></Preferences></InstallProvider>;}
