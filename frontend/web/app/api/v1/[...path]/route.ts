import { NextRequest, NextResponse } from "next/server";
import {privateHeaders,proxyPrivate} from "../../private-proxy";

export const dynamic = "force-dynamic";
const fixed = new Set(["GET:statements/wise/accounts", "POST:statements/wise/preview", "POST:statements/wise/confirm", "GET:dashboard", "GET:auth/session", "POST:auth/demo", "POST:auth/logout", "GET:auth/login", "GET:auth/callback", "GET:accounts", "GET:accounts/sources", "GET:ledger/transactions", "GET:ledger/inventory", "GET:analysis/spending", "GET:analysis/spending/comparison", "GET:analysis/tools", "POST:analysis/tools/execute", "POST:analysis/spending/reduction", "POST:analysis/spending/habits", "GET:public/benchmarks/consumption", "GET:public/benchmarks/category-crosswalk", "GET:public/benchmarks/cohorts", "POST:benchmarks/cohort-selection", "POST:benchmarks/comparison", "GET:coaching/preferences", "POST:coaching/preferences", "GET:insights", "POST:insights/refresh", "GET:insights/planning-preview", "POST:insights/spending-preview", "GET:planning/context", "POST:plans", "GET:plans/current"]);
const job = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = path.join("/");
  const permittedBank = (path.length === 1 && ((path[0] === "banks" && request.method === "GET") ||
    (path[0] === "bank-connections" && ["GET", "POST"].includes(request.method)))) ||
    (path[0] === "bank-connections" && job.test(path[1] ?? "") && (
      (path.length === 2 && request.method === "GET") ||
      (path.length === 3 && ["complete", "disconnect", "scenario", "refresh"].includes(path[2]) && request.method === "POST")));
  const permittedLiveBank = (path[0]==="live-banking" && (
    (path.length===2 && ["capabilities","institutions","connections","callback"].includes(path[1]) && request.method==="GET") ||
    (path.length===2 && path[1]==="connect" && request.method==="POST") ||
    (path.length===4 && path[1]==="connections" && job.test(path[2]??"") &&
      ((["refresh","disconnect"].includes(path[3]) && request.method==="POST") || (path[3]==="data" && request.method==="GET")))));
  const permittedImport = (endpoint === "imports" && ["GET", "POST"].includes(request.method)) ||
    (endpoint === "imports/capabilities" && request.method === "GET") ||
    (path[0] === "imports" && job.test(path[1] ?? "") && ((path.length === 2 && request.method === "GET") ||
      (path.length === 3 && ["upload-links", "submit", "cancel"].includes(path[2]) && request.method === "POST") ||
      (path.length === 3 && path[2] === "validation" && ["GET", "POST"].includes(request.method)) ||
      (path.length === 4 && path[2] === "validation" && ((path[3] === "cancel" && request.method === "POST") ||
        (path[3] === "rejections" && request.method === "GET"))) ||
      (path.length === 3 && path[2] === "publication" && ["GET", "POST"].includes(request.method)) ||
      (path.length === 4 && path[2] === "publication" && ((path[3] === "cancel" && request.method === "POST") ||
        (["accounts", "transactions"].includes(path[3]) && request.method === "GET")))));
  const permittedAccount = path.length===3 && path[0]==="accounts" && job.test(path[1]??"") && path[2]==="inclusion" && request.method==="POST";
  const permittedClassification = path.length===4 && path[0]==="ledger" && path[1]==="transactions" && job.test(path[2]??"") && path[3]==="classification" && request.method==="POST";
  const permittedJob = path[0] === "jobs" && job.test(path[1] ?? "") &&
    ((path.length === 2 && request.method === "GET") || (path.length === 3 && path[2] === "cancel" && request.method === "POST"));
  const permittedPlan = path[0] === "plans" && job.test(path[1] ?? "") && (
    (path.length === 2 && request.method === "GET") ||
    (path.length === 3 && ["review", "allocations"].includes(path[2]) && request.method === "GET") ||
    (path.length === 3 && ["proposal", "allocations"].includes(path[2]) && request.method === "POST") ||
    (path[2] === "allocations" && job.test(path[3] ?? "") && (
      (path.length === 4 && request.method === "GET") ||
      (path.length === 5 && path[4] === "release" && request.method === "POST"))));
  const permittedInsight = path[0] === "insights" && job.test(path[1] ?? "") && ((path.length === 2 && request.method === "GET") ||
    (path.length === 3 && path[2] === "dismiss" && request.method === "POST"));
  const permittedEducation=endpoint==="public/education" && request.method==="GET";
  const permittedCoach=endpoint==="coach/query" && request.method==="POST";
  const permittedStatement=["statements/preview","statements/confirm","statements/wise/classify"].includes(endpoint)&&request.method==="POST";
  const headers=privateHeaders();
  const permittedGoal = (endpoint === "goals" && ["GET", "POST"].includes(request.method)) ||
    (path[0] === "goals" && job.test(path[1] ?? "") && ((path.length === 2 && request.method === "GET") ||
      (path.length === 3 && ["revise", "state", "remove"].includes(path[2]) && request.method === "POST") ||
      (path.length === 3 && path[2] === "allocations" && request.method === "GET") ||
      (path.length === 5 && path[2] === "allocations" && job.test(path[3] ?? "") &&
        ["link", "unlink"].includes(path[4]) && request.method === "POST")));
  if (!fixed.has(`${request.method}:${endpoint}`) && !permittedClassification && !permittedAccount && !permittedJob && !permittedPlan && !permittedBank && !permittedLiveBank && !permittedGoal && !permittedInsight && !permittedImport && !permittedEducation && !permittedCoach && !permittedStatement) return NextResponse.json({ error: { code: "NOT_FOUND" } }, { status: 404, headers });
  return proxyPrivate(request,`/v1/${endpoint}`,endpoint === "statements/wise/preview" ? 2800000 : endpoint === "statements/preview" ? 400000 : ["statements/wise/confirm","statements/confirm"].includes(endpoint) ? 262144 : permittedCoach || endpoint === "plans" && request.method === "POST" ? 65536 : 8192);
}

export const GET = proxy;
export const POST = proxy;
