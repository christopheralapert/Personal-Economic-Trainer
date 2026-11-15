import type {Page} from "@playwright/test";
import fixture from "../../fixtures/synthetic/planning-ui.v1.json";

export async function mockPlanning(page: Page, options: {initial?: "saved" | "reserved"; failAcceptOnce?: boolean; stale?: boolean; failContext?: boolean; failReview?: boolean; foreignCurrency?: boolean} = {}) {
  await page.clock.install({time: new Date(fixture.clock)});
  let state: "none" | "saved" | "reserved" | "released" = options.initial ?? "none";
  // This suite starts at the verified-session boundary. Signed OIDC itself is
  // exercised by the separate database-backed signup/import harness.
  let authenticated = true;
  let failed = false;
  const creates: Record<string,unknown>[] = [];
  const accepts: Record<string,unknown>[] = [];
  const releases: Record<string,unknown>[] = [];
  await page.route("**/api/v1/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace("/api/v1/", "");
    const body = request.postData() ? request.postDataJSON() : undefined;
    const respond = (value: unknown, status=200) => route.fulfill({status, json: value, headers: {"Cache-Control":"private, no-store"}});
    if (path === "auth/demo") {authenticated = true; return respond(fixture.session);}
    if (!authenticated) return respond({error:{code:"UNAUTHENTICATED",message:"Sign in to continue."}},401);
    if (path === "auth/session") return respond(fixture.session);
    if (request.headers()["x-moneylens-session-id"] !== fixture.session.session_id)
      return respond({error:{code:"SESSION_CHANGED",message:"The active profile changed."}},409);
    if (request.method() === "POST" && request.headers()["x-csrf-token"] !== fixture.session.csrf_token)
      return respond({error:{code:"CSRF_REJECTED",message:"Verify the session."}},403);
    if (path === "auth/logout") {authenticated = false; return route.fulfill({status:204});}
    if (path === "planning/context") {
      if (options.failContext) return respond({error:{code:"PLANNING_BACKGROUND_REVIEW_REQUIRED",message:"Use a background source review."}},409);
      const context = structuredClone(fixture.context);
      context.plan_version = state === "none" ? 1 : fixture.states[state].plan.plan_version;
      context.existing_reservations_require_review = state === "reserved";
      if (options.foreignCurrency) {context.accounts[0].currency="USD";context.accounts[0].balance.currency="USD";}
      return respond(context);
    }
    if (path === "plans/current") {
      if (state === "none") return respond(null);
      const plan = structuredClone(fixture.states[state].plan);
      if (options.stale) {
        return respond({...plan,current:false,calculation:null,analysis:{...plan.analysis,status:"blocked",
          result:{currency:"EUR",amount_minor:null},blockers:[{code:"PLANNING_REVIEW_REQUIRED",message:"Review current source facts.",action:"refresh_and_review_plan"}]}});
      }
      return respond(plan);
    }
    if (path === "plans" && request.method() === "POST") {
      creates.push(body);
      if (body.as_of || body.accounts[0].amount_minor !== undefined) throw new Error("UI must not submit authoritative source values.");
      state = "saved"; return respond({plan:fixture.states.saved.plan,calculation:fixture.states.saved.plan.calculation});
    }
    if (state === "none") return respond({error:{code:"NOT_FOUND"}},404);
    const root = `plans/${fixture.states.saved.plan.id}`;
    if (path === root + "/review") {
      if (options.failReview) return respond({error:{code:"BANK_ACCOUNT_ACCESS_REQUIRED",message:"Renew the source consent before reading retained account facts."}},409);
      return respond({...fixture.states[state].review,current:!options.stale});
    }
    if (path === root + "/allocations" && request.method() === "GET") return respond({data_version:1,
      plan_version:fixture.states[state].plan.plan_version,next_cursor:null,rows:state === "reserved" || state === "released" ? [
        {...fixture.receipt,state:state === "released" ? "released" : "active",released_at:state === "released" ? fixture.clock : null}] : []});
    if (path === root + "/proposal") return respond({status:"estimated",surplus_minor:20000,
      desired_discretionary_minor:body.desired_discretionary_minor,savings_capacity_minor:20000-body.desired_discretionary_minor,
      chosen_savings_minor:body.chosen_savings_minor,remaining_spending_minor:20000-body.chosen_savings_minor,blockers:[],persisted:false});
    if (path === root + "/allocations" && request.method() === "POST") {
      accepts.push(body); state = "reserved";
      if (options.failAcceptOnce && !failed) {failed = true; return route.abort("failed");}
      return respond(fixture.receipt);
    }
    if (path === root + `/allocations/${fixture.receipt.id}/release`) {
      releases.push(body); state = "released"; return respond({...fixture.receipt,state:"released",released_at:fixture.clock});
    }
    return respond({error:{code:"NOT_FOUND"}},404);
  });
  return {creates, accepts, releases};
}

export async function signInPlanning(page: Page) {
  await page.goto("/plan");
}
