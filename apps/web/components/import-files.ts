import type {components} from "@contracts";

type Manifest = components["schemas"]["ImportManifestV1"];
export type FileRole = Manifest["files"][number]["role"];
export type SelectedFiles = Partial<Record<FileRole, File>>;
export const roleNames: Record<FileRole,string> = {accounts:"Accounts",transactions:"Transactions",balances:"Balances"};
const roles = new Set(["accounts","transactions","balances"]);
const reference = /^[A-Za-z0-9._:-]{1,100}$/;
const maximumObjectBytes = 5 * 1024 ** 3;

function record(value: unknown): value is Record<string,unknown> {return !!value && typeof value === "object" && !Array.isArray(value);}
function exactKeys(value: Record<string,unknown>, keys: string[]) {return Object.keys(value).length === keys.length && Object.keys(value).every(key=>keys.includes(key));}

/** Small local checks improve file selection. The authenticated API remains authoritative. */
export function readManifest(text: string): Manifest {
  let value: unknown;
  try {value=JSON.parse(text);} catch {throw new Error("The manifest is not valid JSON. Choose the manifest from your compatible synthetic export.");}
  const keys=["mapping_version","source_version","source_customer_ref","currency","timezone","claimed_from","claimed_to_exclusive","files"];
  if (!record(value) || !exactKeys(value,keys) || value.mapping_version!=="moneylens.synthetic-csv.v1" ||
      typeof value.source_version!=="string" || !reference.test(value.source_version) ||
      typeof value.source_customer_ref!=="string" || !reference.test(value.source_customer_ref) ||
      typeof value.currency!=="string" || !/^[A-Z]{3}$/.test(value.currency) ||
      typeof value.timezone!=="string" || !value.timezone || value.timezone.length>100 ||
      typeof value.claimed_from!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.claimed_from) ||
      typeof value.claimed_to_exclusive!=="string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.claimed_to_exclusive) ||
      !Array.isArray(value.files) || value.files.length<2 || value.files.length>3)
    throw new Error("Choose a Money Coach synthetic export manifest with accounts and transactions. Other banking formats need a compatible export first.");
  const seen=new Set<string>();
  for (const file of value.files) {
    if (!record(file) || !exactKeys(file,["role","size_bytes","sha256"]) || typeof file.role!=="string" || !roles.has(file.role) || seen.has(file.role) ||
        typeof file.size_bytes!=="number" || !Number.isSafeInteger(file.size_bytes) || file.size_bytes<1 || file.size_bytes>maximumObjectBytes ||
        typeof file.sha256!=="string" || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("The manifest has an invalid or repeated file entry. Choose the original complete export manifest.");
    seen.add(file.role);
  }
  if (!seen.has("accounts") || !seen.has("transactions")) throw new Error("The export must include accounts and transactions.");
  return value as Manifest;
}

export function sizeLabel(bytes: number) {
  const unit=bytes>=1024**3 ? "GiB" : bytes>=1024**2 ? "MiB" : bytes>=1024 ? "KiB" : "bytes";
  const divisor=unit==="GiB" ? 1024**3 : unit==="MiB" ? 1024**2 : unit==="KiB" ? 1024 : 1;
  return `${new Intl.NumberFormat("en-GB",{maximumFractionDigits:unit==="bytes" ? 0 : 1}).format(bytes/divisor)} ${unit}`;
}

const knownCurrencies=new Set(typeof Intl.supportedValuesOf==="function" ? Intl.supportedValuesOf("currency") : ["EUR","USD","GBP","JPY","KWD"]);
export function nativeMoney(value:number,currency:string) {
  if (!Number.isSafeInteger(value)) return "Amount unavailable";
  if (!knownCurrencies.has(currency)) return `${new Intl.NumberFormat("en-GB").format(BigInt(value))} ${currency} minor units`;
  const format=new Intl.NumberFormat("fi-FI",{style:"currency",currency});
  const places=format.resolvedOptions().maximumFractionDigits ?? 2;
  const divisor=10n**BigInt(places),minor=BigInt(value),absolute=minor<0n ? -minor : minor;
  return (minor<0n ? "−" : "")+format.formatToParts(absolute/divisor).map(part=>part.type==="fraction" ?
    String(absolute%divisor).padStart(places,"0") : part.value).join("");
}

export function sourceProblem(code: string | null) {
  if (!code) return "Check the current status before continuing.";
  if (code==="import_upload_missing") return "One or more source files are missing. Choose the original files and upload them again.";
  if (code.includes("header") || code.includes("syntax") || code.includes("utf8")) return "The file layout could not be read. Use the documented Money Coach synthetic CSV export and start a corrected source.";
  if (code==="import_rejected_rows") return "Some rows need correction. Review their reasons below, then use a new source export.";
  if (code.includes("control_total")) return "The files do not match their declared row counts or totals. Correct the source export before using it.";
  if (code==="import_source_version_changed") return "Another export was put into use first. Review the latest data, then explicitly retry using your checked data.";
  if (code.includes("revision") || code.includes("regressed") || code.includes("removed") || code.includes("accounts_changed")) return "This export would remove or contradict retained source history. Correct its dates, identities or revisions before using it.";
  if (code.includes("balance")) return "The balance observations are ambiguous, missing or older than the data in use. Correct them before using this export.";
  if (code.includes("changed") || code.includes("mismatch") || code.includes("checkpoint")) return "The source could not be matched to its verified files. Start a corrected source export.";
  return "The background work could not finish. Check status, then retry explicitly if it remains available.";
}
