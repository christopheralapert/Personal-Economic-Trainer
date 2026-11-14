import "server-only";
import {Preferences} from "@/i18n/context";
import {PrivatePlan,type PrivatePageName} from "./private-plan";
export function PrivatePage({page="dashboard"}:{page?:PrivatePageName}){
  return <Preferences><PrivatePlan page={page} oidcAvailable={Boolean(process.env.MONEYLENS_OIDC_ISSUER)} demoAvailable={process.env.MONEYLENS_ALLOW_DEMO==="true"}/></Preferences>;
}
