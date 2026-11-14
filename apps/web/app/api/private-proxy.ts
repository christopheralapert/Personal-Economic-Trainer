import {NextRequest,NextResponse} from "next/server";
import {psuContext} from "./psu-context";

export function privateHeaders() {return new Headers({ "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "Vary": "Cookie, Origin" });}

/** The versioned routes must allowlist their endpoint before calling this transport. */
export async function proxyPrivate(request:NextRequest,endpoint:string,bodyLimit=8192) {
  const headers=privateHeaders();
  if (request.nextUrl.search.length > 8192) return NextResponse.json({ error: { code: "REQUEST_TOO_LARGE" } }, { status: 413, headers });
  try {
    const forwarded = new Headers();
    for (const name of ["content-type", "origin", "cookie", "x-csrf-token", "x-moneylens-session-id", "sec-fetch-site"]) {
      const value = request.headers.get(name);
      if (value) forwarded.set(name, value);
    }
    if(request.method==="POST" && /^\/v1\/live-banking\/connections\/[0-9a-f-]{36}\/refresh$/.test(endpoint)) {
      const psu=psuContext(request.headers,endpoint,request.method);
      if(psu){forwarded.set("x-moneylens-psu-context",psu.raw);forwarded.set("x-moneylens-psu-signature",psu.signature);}
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (request.body) {
      const reader = request.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bodyLimit) { await reader.cancel(); return NextResponse.json({ error: { code: "REQUEST_TOO_LARGE" } }, { status: 413, headers }); }
        chunks.push(value);
      }
    }
    const body = size ? Buffer.concat(chunks) : undefined;
    const base = process.env.MONEYLENS_API_URL ?? "http://127.0.0.1:8000";
    const response = await fetch(`${base}${endpoint}${request.nextUrl.search}`, {
      method: request.method, headers: forwarded, body, redirect: "manual", cache: "no-store",
      signal: AbortSignal.timeout(/^\/v1\/live-banking\/connections\/[0-9a-f-]{36}\/refresh$/.test(endpoint)?75000:endpoint==="/v1/coach/query"?45000:15000),
    });
    for (const name of ["content-type", "location", "x-request-id", "clear-site-data", "retry-after"]) {
      const value = response.headers.get(name);
      if (value) headers.set(name, value);
    }
    for (const value of response.headers.getSetCookie()) headers.append("Set-Cookie", value);
    return new NextResponse(response.status === 204 ? null : await response.arrayBuffer(), { status: response.status, headers });
  } catch {
    return NextResponse.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Please try again when connected." } }, { status: 503, headers });
  }
}
