import { test, expect } from "@playwright/test";

test("same-origin proxy preserves private session cookies, scope and logout", async ({ page, context }) => {
  test.skip(process.env.MONEYLENS_BROWSER_IDENTITY !== "true", "Run setup_local_identity.py and enable explicit identity browser checks.");
  await page.goto("/");
  const learning=await page.evaluate(async()=>{
    const response=await fetch("/api/v1/public/education?topic=cash_flow&locale=fi");
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json()};
  });
  expect(learning.status).toBe(200);expect(learning.cache).toContain("no-store");
  expect(learning.body).toMatchObject({topic:"cash_flow",locale:"fi",audience:"general_education"});
  const login = async (profile: string) => page.evaluate(async name => {
    const response = await fetch("/api/v1/auth/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ profile: name }) });
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  }, profile);
  const first = await login("aino");
  expect(first.status).toBe(200);
  expect(first.body.synthetic).toBe(true);
  const cohort=await page.evaluate(async session=>{
    const response=await fetch("/api/v1/benchmarks/cohort-selection",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},body:JSON.stringify({household_code:"1",reference_period:"2022"})});
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json()};
  },first.body);
  expect(cohort.status).toBe(200);expect(cohort.cache).toContain("no-store");
  expect(cohort.body.cohort.code).toBe("1");expect(cohort.body.fallback_used).toBe(false);
  expect(first.cache).toContain("no-store");
  const cookies = await context.cookies();
  expect(cookies.find(cookie => cookie.name === "moneylens_session")?.httpOnly).toBe(true);
  expect(await page.evaluate(() => document.cookie)).not.toContain("moneylens_session");
  const firstAccounts = await page.evaluate(async () => (await fetch("/api/v1/accounts")).json());
  expect(firstAccounts).toHaveLength(2);
  const goals=await page.evaluate(async()=>{
    const list=await fetch("/api/v1/goals?limit=1");
    const missing=await fetch("/api/v1/goals/00000000-0000-0000-0000-000000000000");
    const protectedWrite=await fetch("/api/v1/goals",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const oversized=await fetch("/api/v1/goals",{method:"POST",body:"x".repeat(8193)});
    const invalid=await fetch("/api/v1/goals/not-a-uuid/remove",{method:"POST"});
    const allocationPath="/api/v1/goals/00000000-0000-0000-0000-000000000000/allocations";
    const missingAllocations=await fetch(allocationPath);
    const protectedLink=await fetch(`${allocationPath}/00000000-0000-0000-0000-000000000000/link`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const unknownAction=await fetch(`${allocationPath}/00000000-0000-0000-0000-000000000000/release`,{method:"POST"});
    return {status:list.status,cache:list.headers.get("cache-control"),missing:missing.status,protectedWrite:protectedWrite.status,oversized:oversized.status,invalid:invalid.status,missingAllocations:missingAllocations.status,protectedLink:protectedLink.status,unknownAction:unknownAction.status};
  });
  expect(goals).toEqual({status:200,cache:"private, no-store",missing:404,protectedWrite:403,oversized:413,invalid:404,missingAllocations:404,protectedLink:403,unknownAction:404});
  const insights=await page.evaluate(async session=>{
    const planning=await fetch("/api/v1/insights/planning-preview");
    const spending=await fetch("/api/v1/insights/spending-preview",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},body:JSON.stringify({start:"2026-10-01",end_exclusive:"2026-11-01"})});
    const protectedWrite=await fetch("/api/v1/insights/spending-preview",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    return {planning:planning.status,cache:planning.headers.get("cache-control"),spending:spending.status,persisted:(await spending.json()).persisted,protectedWrite:protectedWrite.status};
  },first.body);
  expect(insights).toEqual({planning:200,cache:"private, no-store",spending:200,persisted:false,protectedWrite:403});
  const preferences=await page.evaluate(async()=>{
    const read=await fetch("/api/v1/coaching/preferences");
    const blocked=await fetch("/api/v1/coaching/preferences",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    return {status:read.status,cache:read.headers.get("cache-control"),external:(await read.json()).state.external_delivery_available,blocked:blocked.status};
  });
  expect(preferences).toEqual({status:200,cache:"private, no-store",external:false,blocked:403});
  const stored=await page.evaluate(async()=>{
    const list=await fetch("/api/v1/insights?limit=1");
    const missing=await fetch("/api/v1/insights/00000000-0000-0000-0000-000000000000");
    const refresh=await fetch("/api/v1/insights/refresh",{method:"POST",headers:{"Content-Type":"application/json"},body:'{"key":"without-csrf"}'});
    const dismiss=await fetch("/api/v1/insights/00000000-0000-0000-0000-000000000000/dismiss",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    return {status:list.status,cache:list.headers.get("cache-control"),missing:missing.status,refresh:refresh.status,dismiss:dismiss.status};
  });
  expect(stored).toEqual({status:200,cache:"private, no-store",missing:404,refresh:403,dismiss:403});
  const accountSources = await page.evaluate(async () => {
    const response = await fetch("/api/v1/accounts/sources");
    return {status:response.status, cache:response.headers.get("cache-control"), rows:await response.json()};
  });
  expect(accountSources.status).toBe(200); expect(accountSources.cache).toContain("no-store");
  expect(accountSources.rows.map((item:{id:string}) => item.id)).toEqual(firstAccounts.map((item:{id:string}) => item.id));
  expect(firstAccounts.every((item:Record<string,unknown>) => !("source" in item))).toBe(true);
  const planning = await page.evaluate(async () => {
    const current = await fetch("/api/v1/plans/current");
    const review = await fetch("/api/v1/planning/context");
    const reviewBody = await review.json();
    const createWithoutCsrf = await fetch("/api/v1/plans", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    const oversizedReview = await fetch("/api/v1/plans", { method: "POST", body: "x".repeat(65537) });
    const missing = await fetch("/api/v1/plans/00000000-0000-0000-0000-000000000000");
    const invalid = await fetch("/api/v1/plans/not-a-uuid/proposal", { method: "POST" });
    const protectedWrite = await fetch("/api/v1/plans/00000000-0000-0000-0000-000000000000/proposal", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ desired_discretionary_minor: 0 }),
    });
    return { current: current.status, cache: current.headers.get("cache-control"), review: review.status,
      reviewAccounts: reviewBody.accounts.length, createWithoutCsrf: createWithoutCsrf.status, oversizedReview: oversizedReview.status, missing: missing.status,
      invalid: invalid.status, protectedWrite: protectedWrite.status };
  });
  expect(planning).toEqual({ current: 200, cache: "private, no-store", review: 200, reviewAccounts: 2,
    createWithoutCsrf: 403, oversizedReview: 413, missing: 404, invalid: 404, protectedWrite: 403 });
  const banks = await page.evaluate(async () => {
    const catalog = await fetch("/api/v1/banks");
    const body = await catalog.json();
    const connections = await fetch("/api/v1/bank-connections");
    const protectedWrite = await fetch("/api/v1/bank-connections", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "untrusted", institution_id: "s-bank-demo" }) });
    const oversized = await fetch("/api/v1/bank-connections", { method: "POST", body: "x".repeat(8193) });
    const missing = await fetch("/api/v1/bank-connections/00000000-0000-0000-0000-000000000000");
    const refresh = await fetch("/api/v1/bank-connections/00000000-0000-0000-0000-000000000000/refresh", { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "refresh-1" }) });
    const invalid = await fetch("/api/v1/bank-connections/not-a-uuid/disconnect", { method: "POST" });
    return { status: catalog.status, cache: catalog.headers.get("cache-control"), ids: body.map((bank: { id: string }) => bank.id),
      modes: body.map((bank: { mode: string }) => bank.mode), connections: connections.status,
      protectedWrite: protectedWrite.status, oversized: oversized.status, missing: missing.status, invalid: invalid.status, refresh: refresh.status };
  });
  expect(banks).toEqual({ status: 200, cache: "private, no-store", ids: ["s-bank-demo", "north-demo"],
    modes: ["synthetic", "synthetic"], connections: 200, protectedWrite: 403, oversized: 413, missing: 404, invalid: 404, refresh: 403 });
  const totals = await page.evaluate(async () => (await fetch("/api/v1/analysis/spending?start=2026-10-01&end_exclusive=2026-11-01")).json());
  expect(totals.net_minor).toBe(86450);
  expect(totals.scope.data_mode).toBe("synthetic");
  const habits=await page.evaluate(async session=>{
    const path="/api/v1/analysis/spending/habits";
    const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},body:JSON.stringify({start:"2026-10-01",end_exclusive:"2026-11-01"})});
    const protectedQuery=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const oversized=await fetch(path,{method:"POST",body:"x".repeat(8193)});
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json(),protectedQuery:protectedQuery.status,oversized:oversized.status};
  },first.body);
  expect(habits.status).toBe(200);expect(habits.cache).toContain("no-store");
  expect(habits.body.baseline).toEqual(totals);
  expect(habits.body.result_kind).toBe("observed_spending_patterns");
  expect(habits.protectedQuery).toBe(403);expect(habits.oversized).toBe(413);
  const tools=await page.evaluate(async session=>{
    const catalog=await fetch("/api/v1/analysis/tools");
    const headers={"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id};
    const query={name:"spending_totals",arguments:{start:"2026-10-01",end_exclusive:"2026-11-01"}};
    const response=await fetch("/api/v1/analysis/tools/execute",{method:"POST",headers,body:JSON.stringify(query)});
    const protectedQuery=await fetch("/api/v1/analysis/tools/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(query)});
    const oversized=await fetch("/api/v1/analysis/tools/execute",{method:"POST",body:"x".repeat(8193)});
    const reads=await Promise.all(["insight_list","coaching_preferences"].map(async name=>{
      const result=await fetch("/api/v1/analysis/tools/execute",{method:"POST",headers,body:JSON.stringify({name,arguments:{}})});
      return {status:result.status,cache:result.headers.get("cache-control"),body:await result.json()};
    }));
    const expanded=await fetch("/api/v2/analysis/tools");
    const financeReads=await Promise.all(["planning_read","bank_connections","population_reference"].map(async name=>{
      const result=await fetch("/api/v2/analysis/tools/execute",{method:"POST",headers,body:JSON.stringify({name,arguments:{}})});
      return {status:result.status,cache:result.headers.get("cache-control"),body:await result.json()};
    }));
    const protectedV2=await fetch("/api/v2/analysis/tools/execute",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:"planning_read",arguments:{}})});
    const oversizedV2=await fetch("/api/v2/analysis/tools/execute",{method:"POST",body:"x".repeat(8193)});
    const forbiddenV2=await fetch("/api/v2/goals");
    return {catalog:catalog.status,names:(await catalog.json()).tools.map((tool:{name:string})=>tool.name),status:response.status,cache:response.headers.get("cache-control"),body:await response.json(),protectedQuery:protectedQuery.status,oversized:oversized.status,reads,
      expanded:expanded.status,expandedBody:await expanded.json(),financeReads,protectedV2:protectedV2.status,oversizedV2:oversizedV2.status,forbiddenV2:forbiddenV2.status};
  },first.body);
  expect(tools.catalog).toBe(200);expect(tools.names).toEqual(["ledger_transactions","spending_totals","spending_comparison","spending_reduction","goal_list","goal_details","goal_allocations","insight_list","insight_details","coaching_preferences"]);
  expect(tools.status).toBe(200);expect(tools.cache).toContain("no-store");expect(tools.body.result).toEqual(totals);
  expect(tools.protectedQuery).toBe(403);expect(tools.oversized).toBe(413);
  for(const read of tools.reads) {expect(read.status).toBe(200);expect(read.cache).toContain("no-store");}
  expect(tools.reads[0].body.name).toBe("insight_list");expect(tools.reads[0].body.result.rows).toEqual([]);
  expect(tools.reads[1].body.name).toBe("coaching_preferences");expect(tools.reads[1].body.result.coaching_enabled).toBe(false);
  expect(tools.expanded).toBe(200);expect(tools.expandedBody.registry_version).toBe("analysis-tools.v2");
  expect(tools.expandedBody.tools.map((tool:{name:string})=>tool.name)).toEqual([...tools.names,"planning_read","bank_connections","population_reference"]);
  expect(tools.protectedV2).toBe(403);expect(tools.oversizedV2).toBe(413);expect(tools.forbiddenV2).toBe(404);
  for(const read of tools.financeReads) {expect(read.status).toBe(200);expect(read.cache).toContain("no-store");}
  expect(tools.financeReads[0].body.name).toBe("planning_read");expect(tools.financeReads[1].body.name).toBe("bank_connections");
  expect(tools.financeReads[2].body.name).toBe("population_reference");
  expect(tools.financeReads[2].body.result.status).toBe("available");
  expect(tools.financeReads[2].body.result.personal_comparison).toBe("not_performed");
  const grounded=await page.evaluate(async session=>{
    const path="/api/v2/analysis/tools/answer";
    const response=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},
      body:JSON.stringify({name:"spending_totals",arguments:{start:"2026-10-01",end_exclusive:"2026-11-01"}})});
    const denied=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const oversized=await fetch(path,{method:"POST",body:"x".repeat(8193)});
    const card=await fetch(`${path}/card?locale=fi`,{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id},
      body:JSON.stringify({name:"spending_totals",arguments:{start:"2026-10-01",end_exclusive:"2026-11-01"}})});
    const cardDenied=await fetch(`${path}/card?locale=fi`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const cardOversized=await fetch(`${path}/card`,{method:"POST",body:"x".repeat(8193)});
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json(),denied:denied.status,oversized:oversized.status,
      card:card.status,cardCache:card.headers.get("cache-control"),cardBody:await card.json(),cardDenied:cardDenied.status,cardOversized:cardOversized.status};
  },first.body);
  expect(grounded.status).toBe(200);expect(grounded.cache).toContain("no-store");
  expect(grounded.body.artifact.result).toEqual(totals);
  expect(grounded.body.facts.find((fact:{fact_id:string})=>fact.fact_id==="net_minor")).toMatchObject({value:totals.net_minor,meaning:"net_observed_spending"});
  expect(grounded.denied).toBe(403);expect(grounded.oversized).toBe(413);
  expect(grounded.card).toBe(200);expect(grounded.cardCache).toContain("no-store");
  expect(grounded.cardBody.locale).toBe("fi");expect(grounded.cardBody.title).toBe("Havaittu kulutus");
  expect(grounded.cardBody.answer.artifact.result).toEqual(totals);
  expect(grounded.cardBody.rows.find((row:{fact_id:string})=>row.fact_id==="net_minor").label).toBe("Havaittu nettokulutus");
  expect(grounded.cardBody.answer.facts.find((fact:{fact_id:string})=>fact.fact_id==="net_minor").value).toBe(totals.net_minor);
  expect(grounded.cardDenied).toBe(403);expect(grounded.cardOversized).toBe(413);
  const coach=await page.evaluate(async session=>{
    const path="/api/v1/coach/query";
    const headers={"Content-Type":"application/json","X-CSRF-Token":session.csrf_token,"X-MoneyLens-Session-ID":session.session_id};
    const response=await fetch(path,{method:"POST",headers,body:JSON.stringify({question:"Show spending from 2026-10-01 until 2026-11-01",card_locale:"sv"})});
    const clarification=await fetch(path,{method:"POST",headers,body:JSON.stringify({question:"How much did I spend on taxis?"})});
    const review=await fetch(path,{method:"POST",headers,body:JSON.stringify({question:"What is safe for me to spend this week?"})});
    const denied=await fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    const oversized=await fetch(path,{method:"POST",body:"x".repeat(8193)});
    const unknown=await fetch(path);
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json(),clarification:await clarification.json(),
      review:await review.json(),denied:denied.status,oversized:oversized.status,unknown:unknown.status};
  },first.body);
  expect(coach.status).toBe(200);expect(coach.cache).toContain("no-store");
  expect(coach.body.interpretation.method).toBe("bounded_english_patterns");
  expect(coach.body.card.title).toBe("Observerad konsumtion");expect(coach.body.card.answer.artifact.result).toEqual(totals);
  expect(coach.clarification.interpretation.reason).toBe("PERIOD_REQUIRED");expect(coach.clarification.card).toBeNull();
  expect(coach.review.interpretation.next_view).toBe("/plan");expect(coach.review.card).toBeNull();
  expect(coach.denied).toBe(403);expect(coach.oversized).toBe(413);expect(coach.unknown).toBe(404);
  const comparison = await page.evaluate(async () => {
    const response=await fetch("/api/v1/analysis/spending/comparison?start=2026-10-01&end_exclusive=2026-11-01&mode=previous_month");
    return {status:response.status,cache:response.headers.get("cache-control"),body:await response.json()};
  });
  expect(comparison.status).toBe(200); expect(comparison.cache).toContain("no-store");
  expect(comparison.body.current.net_minor).toBe(totals.net_minor);
  expect(comparison.body.baseline.scope.start).toBe("2026-09-01");
  expect(comparison.body.status).toBe("limited_comparison");
  expect(comparison.body.current.scope.data_version).toBe(comparison.body.baseline.scope.data_version);
  const evidence = await page.evaluate(async version => {
    let cursor: string | null = null;
    const rows: { id: string; amount_minor: number }[] = [];
    do {
      const query = new URLSearchParams({ start: "2026-10-01", end_exclusive: "2026-11-01", spending_only: "true", limit: "3", expected_data_version: String(version) });
      if (cursor) query.set("cursor", cursor);
      const body = await (await fetch(`/api/v1/ledger/transactions?${query}`)).json();
      rows.push(...body.rows);
      cursor = body.next_cursor;
    } while (cursor);
    return { count: rows.length, net: -rows.reduce((sum, row) => sum + row.amount_minor, 0), distinct: new Set(rows.map(row => row.id)).size };
  }, totals.scope.data_version);
  expect(evidence).toEqual({ count: 8, net: totals.net_minor, distinct: 8 });
  await page.goto("/analysis");
  await expect(page.getByRole("heading",{name:"Follow the spending.",exact:true})).toBeVisible();
  const inspected=page.waitForResponse(response=>response.url().endsWith("/analysis/tools/execute") && response.request().postDataJSON().name==="spending_totals");
  await page.getByRole("button",{name:"Inspect spending",exact:true}).click();
  expect((await (await inspected).json()).result).toEqual(totals);
  await expect(page.getByRole("heading",{name:"Observed spending",exact:true})).toBeFocused();
  await expect(page.locator(".analysis-transactions > li")).toHaveCount(evidence.count);
  await expect(page.locator(".analysis-results")).toContainText("historical spending");
  const second = await login("mika");
  expect(second.status).toBe(200);
  expect(second.body.owner.user_id).not.toBe(first.body.owner.user_id);
  const secondAccounts = await page.evaluate(async () => (await fetch("/api/v1/accounts")).json());
  expect(secondAccounts.map((item: { id: string }) => item.id).some((id: string) => firstAccounts.some((item: { id: string }) => item.id === id))).toBe(false);
  expect((await context.request.get("/api/v1/accounts", {headers:{"X-MoneyLens-Session-ID":first.body.session_id}})).status()).toBe(409);
  expect((await context.request.post("/api/v1/auth/logout", { headers: { Origin: "https://evil.example", "X-CSRF-Token": second.body.csrf_token } })).status()).toBe(403);
  expect(await page.evaluate(async () => (await fetch("/api/v1/auth/logout", { method: "POST" })).status)).toBe(403);
  expect(await page.evaluate(async csrf => (await fetch("/api/v1/auth/logout", { method: "POST", headers: { "X-CSRF-Token": csrf } })).status, second.body.csrf_token)).toBe(204);
  expect(await page.evaluate(async () => (await fetch("/api/v1/accounts")).status)).toBe(401);
});

test("private plan UI verifies real sessions and clears profile drafts across windows", async ({page,context}) => {
  test.skip(process.env.MONEYLENS_BROWSER_IDENTITY !== "true", "Requires local identity fixtures.");
  await page.goto("/plan");
  await page.getByRole("button",{name:"Continue as Aino"}).click();
  await expect(page.getByRole("main")).toContainText("Synthetic Aino");
  const first = await (await context.request.get("/api/v1/auth/session")).json();
  const other = await context.newPage();
  await other.goto("/plan");
  await expect(other.getByRole("main")).toContainText("Synthetic Aino");
  await other.getByRole("button",{name:"Sign out",exact:true}).click();
  await other.getByRole("button",{name:"Continue as Mika"}).click();
  await expect(other.getByRole("main")).toContainText("Synthetic Mika");
  await page.bringToFront();
  await expect(page.getByRole("main")).toContainText("Synthetic Mika");
  await expect(page.getByRole("main")).not.toContainText("Synthetic Aino");
  const next = await (await context.request.get("/api/v1/auth/session")).json();
  expect(next.owner.user_id).not.toBe(first.owner.user_id);
  await page.getByRole("button",{name:"Sign out",exact:true}).click();
  await expect(page.getByRole("button",{name:"Continue as Aino"})).toBeVisible();
  await other.bringToFront();
  await expect(other.getByRole("button",{name:"Continue as Aino"})).toBeVisible();
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(request.url);
    return urls;
  });
  expect(cached.some(url => /\/plan(?:[/?]|$)|\/api\//.test(url))).toBe(false);
  await other.close();
});
