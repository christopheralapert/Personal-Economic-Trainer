import {NextRequest,NextResponse} from "next/server";
import {privateHeaders,proxyPrivate} from "../../private-proxy";

export const dynamic="force-dynamic";
const fixed=new Set(["GET:analysis/tools","POST:analysis/tools/execute","POST:analysis/tools/answer","POST:analysis/tools/answer/card"]);

async function proxy(request:NextRequest,context:{params:Promise<{path:string[]}>}) {
  const {path}=await context.params;
  const endpoint=path.join("/");
  if (!fixed.has(`${request.method}:${endpoint}`)) return NextResponse.json({error:{code:"NOT_FOUND"}},{status:404,headers:privateHeaders()});
  return proxyPrivate(request,`/v2/${endpoint}`);
}

export const GET=proxy;
export const POST=proxy;
