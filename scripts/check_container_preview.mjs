// Artifact smoke check: only the loopback fixture preview, never an external URL.
import assert from "node:assert/strict";

const origin = "http://127.0.0.1:33110";
async function request(path, options = {}) {
  return fetch(origin + path, {...options, redirect: "error", signal: AbortSignal.timeout(10000)});
}
async function json(path, options) {
  const response = await request(path, options);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  return response.json();
}

const page = await request("/");
assert.equal(page.status, 200);
assert.match(page.headers.get("cache-control") ?? "", /no-store/);
const html = await page.text();
assert.match(html, /MoneyLens/);
const bundle = html.match(/(?:src|href)="([^"?]*\/_next\/static\/[^"?]+\.(?:js|css))"/);
assert.ok(bundle, "standalone HTML contains a static bundle");
const asset = await request(bundle[1]);
assert.equal(asset.status, 200);
assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
assert.ok((await asset.arrayBuffer()).byteLength > 0);
for (const path of ["/offline", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png", "/icons/apple-touch-icon.png"]) {
  const response = await request(path);
  assert.equal(response.status, 200, path);
  assert.match(response.headers.get("cache-control") ?? "", /public/);
  assert.ok((await response.arrayBuffer()).byteLength > 0);
}
const worker = await request("/sw.js");
assert.equal(worker.status, 200);
assert.match(worker.headers.get("cache-control") ?? "", /no-store/);
assert.match(await worker.text(), /moneylens-public-[a-f0-9]{16}/);
const manifest = await request("/manifest.webmanifest");
assert.equal(manifest.status, 200);
assert.equal((await manifest.json()).display, "standalone");
const profile = await json("/api/demo/profile");
assert.equal(profile.mode, "synthetic");
assert.ok(profile.accounts.length > 0);
assert.ok(Number.isSafeInteger(profile.available_balance_minor));
const plan = await json("/api/demo/plan", {
  method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify({savings_minor: 0}),
});
assert.equal(plan.persisted, false);
assert.ok(Object.hasOwn(plan, "remaining_spending_minor"));
const education = await json("/api/v1/public/education?topic=cash_flow&locale=fi");
assert.equal(education.audience, "general_education");
assert.equal(education.locale, "fi");
const statistics = await json("/api/v1/public/benchmarks/consumption");
assert.equal(statistics.available, true);
assert.ok(statistics.observations.length > 0);
// The stateless preview must not accidentally expose a private demo session.
const privateSession = await request("/api/v1/auth/session");
assert.equal(privateSession.status, 404);
assert.match(privateSession.headers.get("cache-control") ?? "", /no-store/);
console.log("Container preview passed: standalone assets, PWA headers, same-origin API, synthetic calculation, Finnish education, attributed statistics and disabled private sessions.");
