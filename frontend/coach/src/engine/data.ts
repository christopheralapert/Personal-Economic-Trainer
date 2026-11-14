import {z} from "zod";
import source from "../../data/demo.v1.json";

const minor=z.number().int().safe();
export const dateSchema=z.iso.date();
export const basketSchema=z.enum(["mandatory_regular","mandatory_irregular","everyday","unresolved"]);
export type Basket=z.infer<typeof basketSchema>;
export const transactionSchema=z.object({
  id:z.uuid(),account_id:z.uuid(),amount_minor:minor,currency:z.literal("EUR"),booked_on:dateSchema,
  category:z.string().min(1),merchant:z.string().min(1),
  status:z.enum(["booked","pending","reversed"]),
  economic_flow:z.enum(["expense","refund","income","internal_transfer"]),
  basket:basketSchema,
  basket_basis:z.enum(["regular_bill","everyday_purchase","essential_irregular","ambiguous_purchase","recurring_pattern","not_spending","user_review"]).optional(),
}).superRefine((row,ctx)=>{
  if((row.economic_flow==="expense" && row.amount_minor>0) || (["refund","income"].includes(row.economic_flow) && row.amount_minor<0))
    ctx.addIssue({code:"custom",message:"Amount sign contradicts economic flow"});
});
const profileSchema=z.object({
  as_of:z.iso.datetime({offset:true}),name:z.string(),mode:z.literal("synthetic"),
  peer_context:z.object({age_band:z.enum(["18-24","25-34","35-44","45-54","55-64","65+"]),postal_prefix:z.enum(["00","01","02"]),complete_months:z.number().int().min(0).max(24),restricted:z.boolean().optional()}).optional(),
  transactions:z.array(transactionSchema),
  accounts:z.array(z.object({id:z.uuid(),included:z.boolean(),currency:z.literal("EUR"),name:z.string().min(1).max(160).optional(),institution_id:z.string().min(1).max(80).optional()})),
  balances:z.array(z.object({account_id:z.uuid(),amount_minor:minor,included_credit_minor:minor.nonnegative(),observed_at:z.iso.datetime({offset:true}),pending_reflection:z.literal("included")})),
  bills_minor:minor.nonnegative(),buffer_minor:minor.nonnegative(),essentials_minor:minor.nonnegative(),
});
export type Transaction=z.infer<typeof transactionSchema>;
export type Dataset=z.infer<typeof profileSchema>;
const snapshots=new WeakSet<Dataset>();
/** Only loader-owned, deeply frozen snapshots may have reusable derived indexes. */
export function isLoadedSnapshot(data:Dataset):boolean {return snapshots.has(data);}

export function loadTransactions(input:unknown=source):Dataset {
  const envelope=z.object({notice:z.string(),profiles:z.array(profileSchema).min(1)}).parse(input);
  const profile=envelope.profiles[0];
  if(new Set(profile.accounts.map(a=>a.id)).size!==profile.accounts.length) throw new Error("Duplicate account identity");
  const accounts=new Set(profile.accounts.filter(a=>a.included).map(a=>a.id));
  const ids=new Set<string>();
  for(const row of profile.transactions) {
    if(ids.has(row.id) || !accounts.has(row.account_id)) throw new Error("Duplicate or unowned transaction");
    ids.add(row.id);
  }
  if(profile.balances.some(b=>!accounts.has(b.account_id)) || new Set(profile.balances.map(b=>b.account_id)).size!==profile.balances.length) throw new Error("Invalid balance scope");
  // Zod owns these copies; freezing never mutates the caller's input graph.
  for(const rows of [profile.transactions,profile.accounts,profile.balances]) {
    for(const row of rows) Object.freeze(row);
    Object.freeze(rows);
  }
  if(profile.peer_context)Object.freeze(profile.peer_context);
  Object.freeze(profile);snapshots.add(profile);
  return profile;
}
