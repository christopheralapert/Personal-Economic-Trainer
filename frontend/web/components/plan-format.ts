export function parseEuro(value: string): number {
  const clean = value.trim();
  if (clean.length > 20 || !/^\d+(?:[.,]\d{1,2})?$/.test(clean))
    throw new Error("Enter a nonnegative euro amount with at most two decimals, for example 12.50.");
  const [whole, fraction = ""] = clean.split(/[.,]/);
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minor > 9007199254740991n) throw new Error("This amount exceeds the supported range.");
  return Number(minor);
}

export function sumMinor(values: number[]): number {
  const total = values.reduce((result, value) => result + BigInt(value), 0n);
  if (total > 9007199254740991n || total < -9007199254740991n) throw new Error("The total exceeds the supported range.");
  return Number(total);
}

export const euros = (value: number) => {
  if (!Number.isSafeInteger(value)) throw new Error("Money must be an exact integer in minor units.");
  const minor=BigInt(value),absolute=minor<0n ? -minor : minor;
  const parts=new Intl.NumberFormat("fi-FI",{style:"currency",currency:"EUR",minimumFractionDigits:2,maximumFractionDigits:2})
    .formatToParts(absolute/100n);
  return (minor<0n ? "−" : "")+parts.map(part=>part.type==="fraction" ? String(absolute%100n).padStart(2,"0") : part.value).join("");
};
export const planDate = (value: string) => new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Helsinki",
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"}).format(new Date(value));

export const protectionLabels = {essentials: "Essential living costs", irregular: "Irregular essentials",
  savings: "Existing savings commitments", buffer: "Safety buffer"};

export const blockerText: Record<string, string> = {
  ACCOUNT_COVERAGE_UNKNOWN: "Confirm that the account's current information has been reviewed.",
  BALANCE_MISSING_OR_AMBIGUOUS: "A current typed balance is missing. Review the source details.",
  BALANCE_STALE_OR_MISSING: "The source balance is too old or missing. A fresh source snapshot is needed.",
  BALANCE_STALE: "The source balance is too old. A fresh source snapshot is needed.",
  SYNC_STALE_OR_MISSING: "The source observation is too old. Reloading this form does not refresh the bank data.",
  OWN_FUNDS_COMPONENTS_UNKNOWN: "Review credit and money that cannot be accessed before using this balance.",
  PROTECTION_AMOUNT_UNKNOWN: "Enter an explicit amount for all four protections, including zero where appropriate.",
  PROTECTION_HORIZON_UNREVIEWED: "Review every protection through the full period shown above.",
  PROTECTION_ROUTING_UNRESOLVED: "Assign each protected amount to a paying account exactly once.",
  OBLIGATIONS_UNREVIEWED: "Confirm that you reviewed upcoming bills through the full protection period.",
  LIABILITY_COVERAGE_UNKNOWN: "Review the settlement costs of the credit account.",
  UNSUPPORTED_CURRENCY: "This plan supports EUR accounts. A reviewed currency solution is needed.",
  PENDING_COVERAGE_UNKNOWN: "The source does not say whether pending charges are already in the balance.",
  PENDING_BASIS_UNKNOWN: "The source does not say whether pending charges are already in the balance.",
  ACCOUNT_LIQUIDITY_SHORTFALL: "A paying account cannot cover its costs when they are due. Review account funding and payment routes.",
  DISCRETIONARY_PREFERENCE_UNKNOWN: "Choose the amount you want to keep flexible, including an explicit zero if appropriate.",
  DISCRETIONARY_PREFERENCE_EXCEEDS_SURPLUS: "The desired spending amount exceeds this protective surplus. Review the preference and any shortfall.",
  NO_LIQUID_ACCOUNT: "Include a usable current or savings account before creating a plan.",
  BACKGROUND_SCENARIO_REQUIRED: "This period needs background processing, which is still being built. The period has not been shortened.",
  PAYING_ACCOUNT_SHORTFALL: "A paying account cannot cover its costs. Review the account routing.",
  ACCOUNT_ROUTING_SHORTFALL: "A paying account cannot cover its costs. Review the account routing.",
  SAVINGS_EXCEED_CAPACITY: "Reduce the saving amount or review how much you want to keep for everyday spending.",
  DISCRETIONARY_PREFERENCE_REQUIRED: "Choose how much you want to keep for discretionary spending.",
  PLANNING_REVIEW_REQUIRED: "This plan is no longer current. Review fresh source details before using an amount.",
};
