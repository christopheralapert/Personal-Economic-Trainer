import {z} from "zod";
import source from "../../data/cohorts.v1.json";
import {demo,analyzePeriod,monthPeriod,periodSchema,type Period,type Dataset} from "./index";
import {sourceDate} from "./source-date";
export const peerMetricSchema=z.enum(["taxi","dining","groceries","housing","utilities","health","home_tech","transport","lifestyle","entertainment","travel","mandatory_regular","mandatory_irregular","everyday","unresolved"]);
export type PeerMetric=z.infer<typeof peerMetricSchema>;
const distributionSchema=z.object({n:z.number().int().min(30),median:z.number().int().nonnegative(),p25:z.number().int().nonnegative(),p75:z.number().int().nonnegative()}).refine(value=>value.p25<=value.median && value.median<=value.p75);
const cohortsSchema=z.object({provenance:z.object({transaction_sha256:z.string().length(64),minimum_n:z.number().int().min(30),period:z.object({start:z.iso.date(),through:z.iso.date(),complete_months:z.number().int()}),population:z.string(),rule_version:z.string()}),cells:z.record(z.string(),z.object({n:z.number().int().min(30),metrics:z.record(z.string(),distributionSchema.nullable())}))});
const cohorts=cohortsSchema.parse(source);
const common={metric:peerMetricSchema,period:periodSchema,synthetic:z.literal(true),source:z.literal("Junction S-Pankki synthetic Helsinki-region population"),ruleVersion:z.string()};
export const peerResultSchema=z.discriminatedUnion("status",[
 z.object({...common,status:z.literal("insufficient"),reason:z.enum(["history","cohort","scope","period"])}),
 z.object({...common,status:z.literal("ready"),you:z.number().int().safe().nonnegative(),median:z.number().int().safe().nonnegative(),p25:z.number().int().safe().nonnegative(),p75:z.number().int().safe().nonnegative(),position:z.enum(["below","within","above"]),n:z.number().int().min(30),ageBand:z.string().nullable(),postalPrefix:z.enum(["00","01","02"]).nullable(),level:z.enum(["area_age","age","all"]),months:z.number().int().positive()})
]);
export type PeerResult=z.infer<typeof peerResultSchema>;
/** Synthetic context only. Currency is integer cents; bundle aggregates are whole EUR. */
export function peerComparison(metric:PeerMetric,period:Period,data:Dataset=demo,reference:typeof cohorts=cohorts):PeerResult{
 peerMetricSchema.parse(metric);periodSchema.parse(period);
 const base={metric,period,synthetic:true as const,source:"Junction S-Pankki synthetic Helsinki-region population" as const,ruleVersion:reference.provenance.rule_version};
 const unavailable=(reason:"history"|"cohort"|"scope"|"period"):PeerResult=>({...base,status:"insufficient",reason});
 const context=data.peer_context;
 if(!context || context.complete_months<6 || new Set(data.transactions.map(row=>row.booked_on.slice(0,7))).size<6)return unavailable("history");
 if(context.restricted)return unavailable("scope");
 const through=monthPeriod(reference.provenance.period.through).end;
 if(period.start.slice(-2)!=="01" || period.end.slice(-2)!=="01" || period.start<reference.provenance.period.start || period.end>through || period.end>monthPeriod(sourceDate(data.as_of)).end)return unavailable("period");
 const months=(Number(period.end.slice(0,4))-Number(period.start.slice(0,4)))*12+Number(period.end.slice(5,7))-Number(period.start.slice(5,7));
 const basket=["mandatory_regular","mandatory_irregular","everyday","unresolved"].includes(metric);
 const metricKey=`${basket ? "basket" : "category"}:${metric}`;
 const keys=[`${context.age_band}/${context.postal_prefix}`,context.age_band,"all"];
 for(const [index,key] of keys.entries()){
  const cell=reference.cells[key],distribution=cell?.metrics[metricKey];
  if(!cell || !distribution || cell.n<30 || distribution.n<30)continue;
  const analysis=analyzePeriod(period,data),group=(basket ? analysis.baskets : analysis.categories).find(item=>item.key===metric);
  // Zero is supported only inside this explicitly observed synthetic source scope.
  const you=Math.round((group?.amount??0)/months),p25=distribution.p25*100,p75=distribution.p75*100;
  return peerResultSchema.parse({...base,status:"ready",you,median:distribution.median*100,p25,p75,position:you<p25 ? "below" : you>p75 ? "above" : "within",n:distribution.n,ageBand:index<2 ? context.age_band : null,postalPrefix:index===0 ? context.postal_prefix : null,level:(["area_age","age","all"] as const)[index],months});
 }
 return unavailable("cohort");
}
