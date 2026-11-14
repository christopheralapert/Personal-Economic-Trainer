import {z} from "zod";
import {basketSchema,loadTransactions,isLoadedSnapshot,type Dataset,type Transaction,type Basket} from "./data";
import {sourceDate} from "./source-date";
export const dataScopeSchema=z.object({excludedAccounts:z.array(z.uuid()).max(200).default([]),excludedCategories:z.array(z.string().min(1).max(80)).max(200).default([]),corrections:z.record(z.uuid(),z.object({basket:basketSchema.optional(),category:z.string().min(1).max(80).optional()}).strict()).refine(value=>Object.keys(value).length<=200).default({})}).strict();
export type DataScope=z.infer<typeof dataScopeSchema>;
export const emptyScope:DataScope={excludedAccounts:[],excludedCategories:[],corrections:{}};
const cached=new WeakMap<Dataset,Map<string,Dataset>>();
/** Selectors and local classifications only. Callers never supply balances or transaction amounts. */
export function scopedDataset(source:Dataset,input:unknown=emptyScope):Dataset {
 const scope=dataScopeSchema.parse(input),signature=JSON.stringify(scope);
 if(!scope.excludedAccounts.length && !scope.excludedCategories.length && !Object.keys(scope.corrections).length)return source;
 const previous=isLoadedSnapshot(source) ? cached.get(source)?.get(signature) : undefined;if(previous)return previous;
 const accounts=new Set(source.accounts.map(account=>account.id)),categories=new Set(source.transactions.map(row=>row.category)),rows=new Set(source.transactions.map(row=>row.id));
 if(scope.excludedAccounts.some(id=>!accounts.has(id)) || scope.excludedCategories.some(category=>!categories.has(category)) || Object.entries(scope.corrections).some(([id,value])=>!rows.has(id) || (value.category!==undefined && !categories.has(value.category))))throw new Error("Unknown local data selector");
 const excludedAccounts=new Set(scope.excludedAccounts),excludedCategories=new Set(scope.excludedCategories),filtered=excludedAccounts.size>0 || excludedCategories.size>0;
 const transactions=source.transactions.filter(row=>!excludedAccounts.has(row.account_id) && !excludedCategories.has(row.category)).map(row=>({...row,...scope.corrections[row.id],...(Object.hasOwn(scope.corrections,row.id) ? {basket_basis:"user_review" as const} : {})})).filter(row=>!excludedCategories.has(row.category));
 const profile={...source,...(source.peer_context ? {peer_context:{...source.peer_context,restricted:filtered}} : {}),accounts:source.accounts.map(account=>({...account,included:account.included&&!excludedAccounts.has(account.id)})),transactions,
  // Aggregate reserves cannot be attributed to a reduced scope. Withhold its balance-based allowance.
  balances:filtered ? [] : source.balances,bills_minor:filtered ? 0 : source.bills_minor,buffer_minor:filtered ? 0 : source.buffer_minor,essentials_minor:filtered ? 0 : source.essentials_minor};
 const result=loadTransactions({notice:"Local user classification and scope",profiles:[profile]});
 if(!isLoadedSnapshot(source))return result;
 let entries=cached.get(source);if(!entries){entries=new Map();cached.set(source,entries);}if(entries.size>=32)entries.delete(entries.keys().next().value!);entries.set(signature,result);return result;
}
export function classificationQueue(data:Dataset,corrections:DataScope["corrections"]={}):Transaction[] {
 const included=new Set(data.accounts.filter(account=>account.included).map(account=>account.id)),through=sourceDate(data.as_of),baskets=new Map<string,Set<Basket>>();
 const financial=data.transactions.filter(row=>included.has(row.account_id) && row.booked_on<=through && row.status==="booked" && (row.economic_flow==="expense" || row.economic_flow==="refund"));
 for(const row of financial){const group=baskets.get(row.category)??new Set<Basket>();group.add(row.basket);baskets.set(row.category,group);}
 return financial.filter(row=>!Object.hasOwn(corrections,row.id) && (row.basket==="unresolved" || (baskets.get(row.category)?.size??0)>1));
}
