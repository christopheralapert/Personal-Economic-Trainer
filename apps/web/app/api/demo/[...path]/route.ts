import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const allowed = new Set(["GET:profile", "POST:plan", "POST:scenario", "GET:banks", "POST:banks/command"]);

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = path.join("/");
  if (!allowed.has(`${request.method}:${endpoint}`)) return NextResponse.json({error: {message: "Unknown demo operation."}}, {status: 404});
  if (Number(request.headers.get("content-length")) > 8192) return NextResponse.json({error: {message: "The request is too large."}}, {status: 413});
  const base = process.env.MONEYLENS_DEMO_API_URL ?? "http://127.0.0.1:8001";
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && new TextEncoder().encode(body).byteLength > 8192) return NextResponse.json({error: {message: "The request is too large."}}, {status: 413});
    const response = await fetch(`${base}/v1/demo/${endpoint}`, {
      method: request.method, cache: "no-store", signal: AbortSignal.timeout(5000),
      headers: {"Content-Type": "application/json"},
      body,
    });
    return new NextResponse(await response.text(), {status: response.status, headers: {
      "Content-Type": "application/json", "Cache-Control": "private, no-store",
    }});
  } catch {
    return NextResponse.json({error: {message: "Demo data is temporarily unavailable. Please try again."}}, {status: 503, headers: {"Cache-Control": "private, no-store"}});
  }
}
export const GET = proxy;
export const POST = proxy;
