import {z} from "zod";
import {basketSchema,demo,spendByBasket,spendByCategory,records,exactSum,periodSchema,type Dataset,type Period} from "@/engine";
export const basketPlanSchema=z.object({savingsPercent:z.number().int().min(0).max(100),category:z.string().min(1).max(80),limitMinor:z.number().int().safe().positive().max(100000000),basisPeriod:periodSchema,basketLimits:z.partialRecord(basketSchema,z.number().int().safe().nonnegative())}).strict();
export type BasketPlan=z.infer<typeof basketPlanSchema>;
export function createBasketPlan(category:string,limitMinor:number,savingsPercent:number,period:Period,data:Dataset=demo):BasketPlan {
 const selected=spendByCategory(period,data).find(group=>group.key===category);if(!selected || selected.amount<=0)throw new Error("Category needs a recorded baseline");
 const baskets=new Set(records(period,data,{category}).filter(row=>row.economic_flow==="expense").map(row=>row.basket)),target=baskets.size===1 ? [...baskets][0] : null;
 const limits=Object.fromEntries(spendByBasket(period,data).filter(group=>group.amount>=0).map(group=>[group.key,Math.max(0,group.key===target ? exactSum([group.amount,-selected.amount,limitMinor]) : group.amount)]));
 return basketPlanSchema.parse({category,limitMinor,savingsPercent,basisPeriod:period,basketLimits:limits});
}
export function basketPlanRows(period:Period,plan:BasketPlan,data:Dataset=demo) {
 basketPlanSchema.parse(plan);
 return spendByBasket(period,data).map(group=>({basket:group.key,amount:group.amount,limit:plan.basketLimits[group.key as keyof BasketPlan["basketLimits"]]??null}));
}
