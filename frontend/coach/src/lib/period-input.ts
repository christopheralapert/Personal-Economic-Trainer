import {periodSchema,monthPeriod,snapshot,type Period} from "@/engine";
import {dateSchema} from "@/engine/data";

export type PeriodInputResult={ok:true;period:Period}|{ok:false;reason:"invalid"|"future"};
export function inclusiveThrough(end:string):string {return new Date(Date.parse(end+"T12:00:00Z")-86400000).toISOString().slice(0,10);}
export function periodFromDates(start:string,through:string,asOf=snapshot):PeriodInputResult {
  if(!dateSchema.safeParse(start).success || !dateSchema.safeParse(through).success || !dateSchema.safeParse(asOf).success || start>through) return {ok:false,reason:"invalid"};
  if(through>asOf) return {ok:false,reason:"future"};
  const end=new Date(through+"T12:00:00Z");end.setUTCDate(end.getUTCDate()+1);
  const result=periodSchema.safeParse({start,end:end.toISOString().slice(0,10)});
  return result.success ? {ok:true,period:result.data} : {ok:false,reason:"invalid"};
}
export function periodPreset(kind:"previous"|"snapshot",asOf=snapshot):Period {
  dateSchema.parse(asOf);
  if(kind==="previous") return monthPeriod(asOf,-1);
  const result=periodFromDates(monthPeriod(asOf).start,asOf,asOf);
  if(!result.ok) throw new Error("Invalid snapshot month");return result.period;
}
