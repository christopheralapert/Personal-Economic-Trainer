/* Only public resources enter this cache. Financial routes always use the network. */
const BUILD = "moneylens-public-131377e695625033";
const PRECACHE = ["/offline", "/icons/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/maskable-512.png"];
const MAX_RUNTIME_ENTRIES = 64;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 4 * 1024 * 1024;
const SIZE_HEADER = "X-MoneyLens-Public-Bytes";
let cacheWrites = Promise.resolve(), pendingWrites = 0;

function publicResource(url, request) {
  return url.origin === self.location.origin && !url.search && request.method === "GET" &&
    !request.headers?.has("Authorization") &&
    (PRECACHE.includes(url.pathname) || /^\/_next\/static\/[A-Za-z0-9_./@-]+\.(?:js|css|woff2?|ttf|otf|png|svg|webp)$/.test(url.pathname));
}

// Preview tunnels require their warning bypass even though public asset fetches
// deliberately omit cookies. Never add it to private/API/navigation requests.
function publicNetwork(request) {
  const headers = new Headers(request.headers);
  if (new URL(self.location.origin).hostname.endsWith(".ngrok-free.dev"))
    headers.set("ngrok-skip-browser-warning", "1");
  // Script requests can be no-cors; that mode strips the bypass header. The
  // public-resource allowlist guarantees this is a same-origin URL.
  return fetch(request, {credentials: "omit", mode: "same-origin", headers});
}

function publicContent(request, response) {
  return new URL(request.url).pathname === "/offline" ||
    !/^(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("Content-Type") || "");
}

function cacheable(response) {
  const length = response.headers.get("Content-Length");
  return response.status === 200 && response.type === "basic" && !response.redirected &&
    !response.headers.has(SIZE_HEADER) &&
    (length === null || /^\d+$/.test(length) && Number(length) <= MAX_ENTRY_BYTES) &&
    !/(?:^|,)\s*(?:private|no-store|no-cache)\b/i.test(response.headers.get("Cache-Control") || "") &&
    !(response.headers.get("Vary") || "").split(",").some(value => ["*", "cookie", "authorization"].includes(value.trim().toLowerCase()));
}

function verifiedCached(response) {
  const size = response?.headers.get(SIZE_HEADER);
  return response?.status === 200 && size !== null && size !== undefined && /^\d+$/.test(size) && Number(size) <= MAX_ENTRY_BYTES;
}

async function boundedCopy(response) {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = []; let size = 0, expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}); }, 10000);
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (expired) return null;
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ENTRY_BYTES) { void reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    const headers = new Headers(response.headers);
    headers.delete("Content-Encoding"); headers.set("Content-Length", String(size)); headers.set(SIZE_HEADER, String(size));
    return new Response(raw, {status: 200, headers});
  } finally { clearTimeout(timer); reader.releaseLock(); }
}

async function storePublic(request, copy) {
  const cache = await caches.open(BUILD), entries = [];
  let bytes = 0;
  for (const key of await cache.keys()) {
    const cached = await cache.match(key);
    const size = cached?.headers.get(SIZE_HEADER);
    const url = new URL(key.url);
    if (!publicResource(url, key) || size === null || size === undefined || !/^\d+$/.test(size) || Number(size) > MAX_ENTRY_BYTES) {
      await cache.delete(key); continue;
    }
    if (key.url === request.url) { await cache.delete(key); continue; }
    entries.push({key, size: Number(size), pinned: PRECACHE.includes(url.pathname)}); bytes += Number(size);
  }
  const newSize = Number(copy.headers.get(SIZE_HEADER));
  const newRuntime = PRECACHE.includes(new URL(request.url).pathname) ? 0 : 1;
  let runtimeEntries = entries.filter(entry => !entry.pinned).length;
  for (const entry of entries.filter(entry => !entry.pinned)) {
    if (runtimeEntries + newRuntime <= MAX_RUNTIME_ENTRIES && bytes + newSize <= MAX_BYTES) break;
    await cache.delete(entry.key); bytes -= entry.size; runtimeEntries--;
    entries.splice(entries.indexOf(entry), 1);
  }
  if (runtimeEntries + newRuntime > MAX_RUNTIME_ENTRIES || bytes + newSize > MAX_BYTES) return;
  try { await cache.put(request, copy); }
  catch (error) {
    // Origin quota can be smaller than our application budget. Free one old
    // runtime entry for a future attempt; never evict the pinned offline shell
    // or retry an uncertain write automatically.
    if (error?.name === "QuotaExceededError") {
      const oldest = entries.find(entry => !entry.pinned);
      if (oldest) await cache.delete(oldest.key);
    }
  }
}

function scheduleCache(request, response, owned = false) {
  // Admit before cloning: bursts cannot retain an unbounded queue of bodies.
  if (pendingWrites >= 4 || !cacheable(response) || !publicContent(request, response)) {
    if (owned) void response.body?.cancel().catch(() => {});
    return Promise.resolve();
  }
  let clone;
  try { clone = owned ? response : response.clone(); } catch { return Promise.resolve(); }
  pendingWrites++;
  // Consume the bounded clone immediately. Queuing an unread tee branch could
  // otherwise retain an arbitrarily large network body behind another write.
  return boundedCopy(clone).then(copy => {
    if (!copy) return;
    const write = cacheWrites.then(() => storePublic(request, copy));
    cacheWrites = write.catch(() => {});
    return write;
  }).catch(() => {}).finally(() => {pendingWrites--;});
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    for (const path of PRECACHE) {
      try {
        const request = new Request(new URL(path, self.location.origin), {credentials: "omit"});
        await scheduleCache(request, await publicNetwork(request), true);
      } catch { /* Online use remains available when storage or a public asset is unavailable. */ }
    }
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("moneylens-public-") && key !== BUILD).map(key => caches.delete(key)))).catch(() => {}));
});
self.addEventListener("message", event => {
  if (event.data?.type === "ACTIVATE_UPDATE" && event.source?.url && new URL(event.source.url).origin === self.location.origin) self.skipWaiting();
});
self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (publicResource(url, request)) {
    const operation = (async () => {
      let stored;
      try { stored = await (await caches.open(BUILD)).match(request); } catch { /* Network remains usable. */ }
      if (verifiedCached(stored) && publicContent(request, stored)) return stored;
      const response = await publicNetwork(request);
      return response;
    })();
    event.respondWith(operation);
    // Lifetime is registered synchronously; background storage never delays
    // delivery of an online response or changes its success into a cache error.
    event.waitUntil(operation.then(response => scheduleCache(request, response)).catch(() => {}));
  } else if (request.mode === "navigate" && url.origin === self.location.origin && request.method === "GET" && ["/", "/demo", "/demo/basic"].includes(url.pathname)) {
    event.respondWith(fetch(request).catch(async () => {
      try {
        const stored = await (await caches.open(BUILD)).match("/offline");
        return verifiedCached(stored) ? stored : Response.error();
      }
      catch { return Response.error(); }
    }));
  }
  // No interception/persistence of APIs, RSC query payloads, callbacks, auth, or writes.
});
