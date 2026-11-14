import type {NextConfig} from "next";
import {coachRevision} from "./scripts/revision.mjs";
import path from "node:path";
const revision=coachRevision();
const config: NextConfig = {
  output:"standalone",
  // Keep the verified synthetic release immutable across requests and restarts.
  experimental:{isrFlushToDisk:false},
  outputFileTracingRoot:path.resolve(__dirname),
  poweredByHeader: false,
  agentRules: false,
  env:{NEXT_PUBLIC_MONEY_COACH_REVISION:revision},
  async headers() {return [{source: "/:path*", headers: [
    {key: "X-Content-Type-Options", value: "nosniff"},
    {key: "Referrer-Policy", value: "no-referrer"},
    {key: "X-Money-Coach-Revision", value:revision},
  ]},{source:"/:path((?!_next/static/).*)",headers:[
    {key: "Cache-Control", value: "private, no-store"},
  ]}, ...["/", "/kit", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/icon-512.png", "/icon-maskable.png", "/apple-touch-icon.png"].map(source=>({source,headers:[
    // This standalone app contains only the bundled, public authored fixture.
    // Never apply these headers to the private MoneyLens application or API.
    {key:"Cache-Control",value:"public, max-age=0, must-revalidate"},
    {key:"X-Money-Coach-Public",value:"synthetic-shell.v1"},
  ]}))];},
};
export default config;
