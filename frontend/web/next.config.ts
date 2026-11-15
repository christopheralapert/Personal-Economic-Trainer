import type { NextConfig } from "next";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
const {webSourceRevision}=createRequire(path.join(__dirname,"next.config.ts"))(path.join(__dirname,"../../scripts/web_revision.mjs")) as {webSourceRevision:()=>string};
let revision="unversioned";
try {revision=execFileSync("git",["rev-parse","--short","HEAD"],{cwd:path.join(__dirname,"../.."),windowsHide:true,stdio:["ignore","pipe","ignore"]}).toString().trim();} catch { /* Container builds may omit Git metadata. */ }
const worker=readFileSync(path.join(__dirname,"public/sw.js"),"utf8");
const buildIdentity=`${revision}-${worker.match(/moneylens-public-([a-f0-9]+)/)?.[1]??"development"}-${webSourceRevision().slice(0,12)}`;

const config: NextConfig = {
  distDir: process.env.MONEYLENS_NEXT_DIST || ".next",
  generateBuildId:async()=>buildIdentity,
  // The demo validates its AI SDK stream against this public artifact ID.
  env:{NEXT_PUBLIC_MONEY_COACH_REVISION:buildIdentity},
  output: process.env.MONEYLENS_STANDALONE === "true" ? "standalone" : undefined,
  outputFileTracingRoot: path.join(__dirname, "../.."),
  poweredByHeader: false,
  logging: { incomingRequests: false, serverFunctions: false, browserToTerminal: false },
  async headers() {
    return [
      { source: "/:path*", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-MoneyLens-Build", value: buildIdentity },
        { key: "X-MoneyLens-UI", value: "authenticated-home.v1" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
      ] },
      { source: "/:path((?!_next/static/).*)", headers: [
        { key: "Cache-Control", value: "private, no-store" },
      ] },
      ...["/offline", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"].map(source => ({source, headers: [
        {key: "Cache-Control", value: "public, max-age=0, must-revalidate"},
      ]})),
      { source: "/sw.js", headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
      ] },
    ];
  },
};
export default config;
