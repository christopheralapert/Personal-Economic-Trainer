import {z} from "zod";
import {exactSum,records,type Period,type Dataset,demo} from "@/engine";
export const monthlyPlanSchema=z.object({id:z.uuid(),name:z.string().trim().min(1).max(80),monthlyMinor:z.number().int().safe().positive().max(100000000),targetMinor:z.number().int().safe().positive(),contributedMinor:z.number().int().safe().nonnegative().nullable()}).strict();
export type MonthlyPlan=z.infer<typeof monthlyPlanSchema>;
export function purchaseEquivalent(monthly:number|null,period:Period,data:Dataset=demo) {
 if(monthly===null || monthly<=0)return null;
 const expenses=records(period,data).filter(row=>row.category==="coffee" && row.economic_flow==="expense" && row.amount_minor<0);
 if(!expenses.length)return null;
 const average=Math.round(exactSum(expenses.map(row=>-row.amount_minor))/expenses.length),count=Math.floor(monthly/average);
 return count>0 ? {category:"coffee",average,count} : null;
}
