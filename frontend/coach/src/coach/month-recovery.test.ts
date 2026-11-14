import {it,expect} from "vitest";
import {interpretQuestion} from "./intent";
import {RuleProvider} from "./rule-provider";
import {monthRecovery,matchingMonths,questionForMonth} from "./month-recovery";
import {questionContextSchema} from "./question-context";
import {lastMonth} from "@/engine";
import {extendedDemo} from "@/engine/datasets";
import {scopedDataset} from "@/engine/data-scope";

it("understands a single named month at the beginning, middle or end without editing quoted merchants",()=>{
 for(const question of ["In September 2026, how much did I spend on taxis?","How much did I spend in September 2026 on taxis?","How much did I spend on taxis September 2026?","Kui palju kulutasin septembris taksole?","Paljonko käytin syyskuussa takseihin?"])expect(interpretQuestion(question,lastMonth),question).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"taxi"},period:{start:"2026-09-01",end:"2026-10-01"}});
 expect(interpretQuestion('Show transactions at "Cafe in September" in October')).toMatchObject({status:"ready",scope:{merchant:"Cafe in September"},period:lastMonth});
 for(const question of ["How much did I spend in September and October?","How much did I spend in September except weekends?","What if I cut dining out in September by 20% and coffee by 50%?"])expect(interpretQuestion(question).status).not.toBe("ready");
});

it("recovers an empty answer with real matching months and preserves every selector in each language",async()=>{
 const question='Show transactions in category "taxi" at "Demo taxi" in April 2026',answer=await new RuleProvider().answer(question,"en",10,{data:extendedDemo,period:lastMonth});
 const context=monthRecovery(answer,question,lastMonth)!;expect(context).not.toBeNull();
 const months=matchingMonths(context,extendedDemo);expect(months.some(month=>month.start==="2026-09-01")).toBe(true);expect(months.some(month=>month.start==="2026-04-01")).toBe(false);
 for(const locale of ["en","fi","et"] as const)expect(interpretQuestion(questionForMonth(context,lastMonth,locale)!)).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"taxi",merchant:"Demo taxi"},period:lastMonth});
 expect(matchingMonths(context,scopedDataset(extendedDemo,{excludedCategories:["taxi"]}))).toEqual([]);
 expect(monthRecovery(await new RuleProvider().answer("How much did I spend on taxis last month?","en",10,{data:extendedDemo}),"How much did I spend on taxis last month?",lastMonth)).toBeNull();
});

it("offers a month for a monthless scenario with a partial selection, retaining category and exact percentage",async()=>{
 const question="What if I cut dining out by 20,25%?",partial={start:"2026-11-01",end:"2026-11-05"},answer=await new RuleProvider().answer(question,"en",10,{data:extendedDemo,period:partial});
 const context=monthRecovery(answer,question,partial)!;expect(context).toMatchObject({tool:"showWhatIf",input:{category:"dining",pct:20.25}});
 expect(matchingMonths(context,extendedDemo).every(month=>month.end.endsWith("-01"))).toBe(true);
 for(const locale of ["en","fi","et"] as const)expect(interpretQuestion(questionForMonth(context,lastMonth,locale)!)).toMatchObject({status:"ready",tool:"showWhatIf",category:"dining",pct:20.25,period:lastMonth});
 const filters=questionContextSchema.parse({tool:"showFilter",input:{period:lastMonth,value:"reserved",category:"taxi",merchant:"September cafe"}});
 for(const locale of ["en","fi","et"] as const)expect(interpretQuestion(questionForMonth(filters,lastMonth,locale)!),questionForMonth(filters,lastMonth,locale)!).toMatchObject({status:"ready",tool:"showFilter",value:"reserved",scope:{category:"taxi",merchant:"September cafe"},period:lastMonth});
});
