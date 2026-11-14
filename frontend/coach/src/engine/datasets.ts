import {z} from "zod";
import extendedSource from "../../data/extended.v1.json";
import manifestSource from "../../data/organizer-manifest.v1.json";
import {demo,loadTransactions,type Dataset} from "./index";
const entrySchema=z.object({file:z.string().regex(/^organizer-[1-8]\.v1\.json$/),age_band:z.enum(["18-24","25-34","35-44","45-54","55-64","65+"]),postal_prefix:z.enum(["00","01","02"]),complete_months:z.number().int().min(6).max(24),rows:z.number().int().positive(),tags:z.array(z.enum(["salaried","housing","frequent_taxis","dining_heavy","investment","mortgage_link","multi_account"]))}).strict();
export const organizerManifest=z.record(z.string().regex(/^organizer[1-8]$/),entrySchema).parse(manifestSource);
export const datasetKeys=[...Object.keys(organizerManifest),"starter","extended"] as const;
export const datasetKeySchema=z.string().refine(value=>value==='session'||datasetKeys.includes(value),"Unknown demo dataset");
export type DatasetKey=z.infer<typeof datasetKeySchema>;
export const extendedDemo=loadTransactions(extendedSource);
const cache=new Map<string,Dataset>([["starter",demo],["extended",extendedDemo]]);
const pending=new Map<string,Promise<Dataset>>();
const loaders:Record<string,()=>Promise<{default:unknown}>>={
 organizer1:()=>import("../../data/organizer-1.v1.json"),organizer2:()=>import("../../data/organizer-2.v1.json"),
 organizer3:()=>import("../../data/organizer-3.v1.json"),organizer4:()=>import("../../data/organizer-4.v1.json"),
 organizer5:()=>import("../../data/organizer-5.v1.json"),organizer6:()=>import("../../data/organizer-6.v1.json"),
 organizer7:()=>import("../../data/organizer-7.v1.json"),organizer8:()=>import("../../data/organizer-8.v1.json"),
};
/** Only the selected public synthetic persona is fetched, outside boot dependencies. */
export async function loadDataset(key:DatasetKey):Promise<Dataset>{
 if(key==='session'){
  if(typeof window==='undefined')throw Error('Session data requires a cookie-bound server loader');
  const response=await fetch('/api/demo-statements/dataset',{cache:'no-store'});if(!response.ok)throw Error('Demo session unavailable');
  return loadTransactions(await response.json());
 }
 const checked=datasetKeySchema.parse(key),loaded=cache.get(checked);if(loaded)return loaded;
 const previous=pending.get(checked);if(previous)return previous;
 const request=loaders[checked]().then(module=>{const data=loadTransactions(module.default);cache.set(checked,data);return data;}).finally(()=>pending.delete(checked));
 pending.set(checked,request);return request;
}
/** An unloaded key never substitutes another customer's data. */
export function datasetFor(key:DatasetKey):Dataset{datasetKeySchema.parse(key);const data=cache.get(key);if(!data)throw new Error("Load the selected dataset first");return data;}
export const sourceCopyKey=(key:DatasetKey)=>key.startsWith("organizer") ? "organizerSourceNote" as const : key==="extended" ? "extendedSourceNote" as const : "sourceNote" as const;
