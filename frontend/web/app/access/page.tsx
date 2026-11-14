import {AccessNotReady} from "@web/components/access-not-ready";
import {Preferences} from "@/i18n/context";
export const dynamic="force-dynamic";
export default function AccessPage(){return <Preferences><AccessNotReady/></Preferences>;}
