import {test, expect} from "@playwright/test";

test("public category crosswalk preserves source definitions and ambiguous categories through the proxy",async ({request})=>{
  const response=await request.get("/api/v1/public/benchmarks/category-crosswalk");
  expect(response.status()).toBe(200);expect(response.headers()["cache-control"]).toContain("no-store");
  const body=await response.json();expect(body.available).toBe(true);
  expect(body.policy.classification_version).toBe("COICOP2018");expect(body.policy.mapping_version).toBe("moneylens.coicop2018.v1");
  expect(body.policy.policy_sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(body.policy.rules.find((rule:{category:string})=>rule.category==="groceries")).toMatchObject({status:"ambiguous",target_code:null});
  expect(body.policy.targets.find((target:{code:string})=>target.code==="07322").label).toContain("Passenger transport by taxi");
  expect(body.policy.snapshot_id).toBe("statfin-ktutk-2022-51770478e803db26");
  const cohorts=await(await request.get("/api/v1/public/benchmarks/cohorts")).json();
  expect(cohorts.available).toBe(true);expect(cohorts.catalog.cohorts).toHaveLength(7);
  expect(cohorts.catalog.cohorts.find((item:{code:string})=>item.code==="SSS").specificity).toBe("all_households");
});

test("public Statistics Finland context preserves real source, year and missing cells", async ({request}) => {
  const response = await request.get("/api/v1/public/benchmarks/consumption");
  expect(response.ok()).toBe(true);
  const body = await response.json();
  expect(body.available).toBe(true);
  expect(body.snapshot.reference_period).toBe("2022");
  expect(body.snapshot.statistic_type).toBe("mean");
  expect(body.snapshot.attribution).toContain("Statistics Finland");
  expect(body.observations).toHaveLength(42);
  expect(body.observations.filter((item: { annual_mean_minor: number | null }) => item.annual_mean_minor === null)).toHaveLength(4);
  expect(response.headers()["cache-control"]).toContain("no-store");
});

test("install manifest and icon URLs are usable in the production build", async ({request}) => {
  const response = await request.get("/manifest.webmanifest");
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.display).toBe("standalone");
  expect(manifest.id).toBe("/");
  for (const icon of manifest.icons) {
    const asset = await request.get(icon.src);
    expect(asset.ok()).toBe(true);
    expect(asset.headers()["content-type"]).toContain("image/png");
    expect(asset.headers()["cache-control"]).not.toContain("private");
  }
});

test("synthetic plan is grounded and slider changes paired preview", async ({page}) => {
  await page.goto("/demo/basic");
  await expect(page.getByRole("heading", {name:"Your spending room"})).toBeVisible();
  await expect(page.locator(".spending-amount")).toContainText("150");
  await page.getByLabel("Try a savings allocation").fill("10000");
  await expect(page.locator(".spending-amount")).toContainText("100");
  await page.getByLabel("Ask about the demo finances").fill("How much did I spend on taxis last month?");
  await page.getByRole("button", {name:"Ask question", exact:true}).click();
  await expect(page.locator(".coach-answer")).toContainText("40");
  await expect(page.locator(".coach-answer")).toContainText("2 taxi payments");
});

test("transaction filter and dining scenario use real fixture calculations", async ({page}) => {
  await page.goto("/demo/basic");
  await expect(page.getByRole("heading", {name:"Your spending room"})).toBeVisible();
  await page.getByRole("button", {name:"Transactions", exact:true}).click();
  await page.getByLabel("Find a merchant or category").fill("taxi");
  await expect(page.locator(".transaction-row")).toHaveCount(2);
  await page.getByRole("button", {name:"What if", exact:true}).click();
  await expect(page.locator(".scenario-results")).toContainText("600");
  await page.getByLabel("Reduce dining out by").fill("40");
  await expect(page.locator(".scenario-results")).toContainText("1 200");
});

test("public offline shell works and personal responses never enter Cache Storage", async ({page, context}) => {
  const workerErrors:string[]=[];
  const diagnostics=await context.newCDPSession(page);
  await diagnostics.send("ServiceWorker.enable");
  diagnostics.on("ServiceWorker.workerErrorReported",event=>workerErrors.push(event.errorMessage.errorMessage));
  await page.goto("/demo/basic");
  await expect(page.getByRole("heading", {name:"Your spending room"})).toBeVisible();
  try {
    await expect.poll(()=>page.evaluate(async()=>{
      const registration=await navigator.serviceWorker.getRegistration();
      return registration?.active?.state ?? registration?.installing?.state ?? "unregistered";
    }),{timeout:10000,message:"The public offline worker must activate"}).toBe("activated");
  } catch(error) {
    throw new Error(`${error}\nWorker errors: ${workerErrors.join("; ")}`);
  }
  await diagnostics.detach();
  await page.reload();
  await expect(page.getByRole("heading", {name:"Your spending room"})).toBeVisible();
  const bundle=await page.locator('script[src^="/_next/static/"]').first().getAttribute("src");
  expect(bundle).toBeTruthy();
  const immutable=await context.request.get(bundle!);
  expect(immutable.headers()["cache-control"]).toContain("immutable");
  const cacheState = await page.evaluate(async () => {
    const urls: string[] = [];
    let bytes=0,runtime=0,valid=true;
    for (const name of await caches.keys()) for (const item of await (await caches.open(name)).keys()) {
      urls.push(item.url);
      const response=await(await caches.open(name)).match(item);
      const actual=(await response!.arrayBuffer()).byteLength;
      valid=valid && actual===Number(response!.headers.get("X-MoneyLens-Public-Bytes")) && actual<=4*1024**2;
      bytes+=actual;if(new URL(item.url).pathname.startsWith("/_next/static/")) runtime++;
    }
    return {urls,bytes,runtime,valid};
  });
  expect(cacheState.urls.some(url => url.includes("/offline"))).toBe(true);
  expect(cacheState.urls.some(url => url.includes("/api/") || new URL(url).pathname === "/")).toBe(false);
  expect(cacheState.valid).toBe(true);expect(cacheState.bytes).toBeLessThanOrEqual(32*1024**2);
  expect(cacheState.runtime).toBeLessThanOrEqual(64);
  const worker=context.serviceWorkers()[0];
  await worker.evaluate(()=>{
    const storage=caches as CacheStorage & {testOriginalOpen?:CacheStorage["open"]};
    storage.testOriginalOpen=storage.open;
    storage.open=async()=>{throw new DOMException("Synthetic storage denial","SecurityError");};
  });
  try {
    const network=await page.evaluate(async()=>{
      const response=await fetch("/icons/icon-192.png",{cache:"no-store"});
      return {status:response.status,bytes:(await response.arrayBuffer()).byteLength};
    });
    expect(network.status).toBe(200);expect(network.bytes).toBeGreaterThan(0);
  } finally {
    await worker.evaluate(()=>{
      const storage=caches as CacheStorage & {testOriginalOpen?:CacheStorage["open"]};
      storage.open=storage.testOriginalOpen!;delete storage.testOriginalOpen;
    });
  }
  await context.setOffline(true);
  await page.goto("/demo/basic");
  await expect(page.getByRole("heading", {name:"A little pause. Your plan can wait."})).toBeVisible();
  await expect(page.getByText("Personal balances and financial results are not stored for offline use.")).toBeVisible();
});

test("mobile and desktop layout retain readable content without page overflow", async ({page}) => {
  for (const [width,height,scheme] of [[1440,1000,"light"],[360,900,"dark"],[320,900,"light"]] as const) {
    await page.setViewportSize({width,height});
    await page.emulateMedia({colorScheme:scheme,reducedMotion:"reduce"});
    await page.goto("/demo/basic");
    await expect(page.getByRole("heading", {name:"Your spending room"})).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const contrasts = await page.locator(".nav-item.active,.avatar,.estimate-label").evaluateAll(elements => {
      function luminance(color: string) {
        const rgb = (color.match(/[\d.]+/g) ?? []).slice(0,3).map(Number).map(value => {
          const c = value / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
        });
        return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
      }
      return elements.map(element => {
        const style = getComputedStyle(element);
        const a = luminance(style.color), b = luminance(style.backgroundColor);
        return (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
      });
    });
    for (const contrast of contrasts) expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({path:`.impeccable/review/${width === 1440 ? "desktop" : width === 360 ? "mobile" : "narrow"}.png`,fullPage:true});
  }
  await page.evaluate(() => {document.documentElement.style.fontSize = "200%";});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({path:".impeccable/review/text-200.png",fullPage:true});
});
