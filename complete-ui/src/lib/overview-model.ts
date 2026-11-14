import {summary,type Dataset,type Period} from "@/engine";
import {recurringIncome} from "@/engine/planning";
/** Display evidence only: never adds estimated or future income to spendable funds. */
export function overviewIncome(period:Period,data:Dataset,userEstimate:number|null) {
 const recorded=summary(period,data).income;
 if(recorded!==null && recorded>0)return {amount:recorded,source:"recorded" as const,needsInput:false};
 if(userEstimate!==null)return {amount:userEstimate,source:"user" as const,needsInput:false};
 const inferred=recurringIncome(data);
 return {amount:inferred,source:inferred===null ? null : "inferred" as const,needsInput:inferred===null};
}
/** Round downward for the compact display; the sheet retains exact engine amounts. */
export const wholeMoney=(minor:number)=>new Intl.NumberFormat("fi-FI",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(Math.floor(minor/100));
export const wholeNumber=(minor:number)=>new Intl.NumberFormat("fi-FI",{maximumFractionDigits:0}).format(Math.floor(minor/100));
