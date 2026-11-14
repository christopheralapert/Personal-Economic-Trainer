// Read-only local preflight. Never imports a provider, calls fetch or prints secrets.
const pools=[
  {name:"large",dailyTokens:250000,models:["gpt-5.4","gpt-5.2","gpt-5.1","gpt-5","gpt-4.1","gpt-4o","o1","o3"]},
  {name:"small",dailyTokens:2500000,models:["gpt-5.4-mini","gpt-5.4-nano","gpt-5-mini","gpt-5-nano","gpt-4.1-mini","gpt-4.1-nano","gpt-4o-mini","o3-mini","o4-mini"]},
];
const model=process.env.MONEY_COACH_MODEL_NAME ?? "gpt-4.1-mini";
const pool=pools.find(entry=>entry.models.includes(model));
const keyPresent=Boolean(process.env.MONEYLENS_OPENAI_API_KEY?.trim());
const reasons=[...(!keyPresent ? ["api_key_missing"] : []),...(!pool ? ["model_not_in_user_screenshot"] : []),
  "project_sharing_unverified","shared_remaining_allowance_unverified","other_organization_usage_unverified"];
console.log(JSON.stringify({
  check:"money-coach-local-preflight.v1",
  apiKeyPresent:keyPresent,
  // Unrecognized configuration is deliberately not echoed; it could contain a secret.
  model:pool ? model : "unlisted",
  screenshotPool:pool ? {name:pool.name,dailyTokens:pool.dailyTokens} : null,
  allowanceEvidence:"user_screenshot_2026-11-06_not_live_account_verification",
  billingPolicy:process.env.MONEYLENS_MODEL_BILLING_POLICY==="free_only" ? "free_only" : "not_verified_free_only",
  liveRequestsMade:0,
  liveReady:false,
  reasons,
},null,2));
// A successful local inspection must not be mistaken for permission to send traffic.
process.exitCode=2;
