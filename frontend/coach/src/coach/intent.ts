import {z} from "zod";
import {dictionaries,type Key} from "@/i18n/dictionaries";
import {isCalendarMonth,monthPeriod,periodSchema,snapshot,type Period,type TransactionFilters} from "@/engine";
import {basketSelector} from "./basket-language";
import {categoryAliases,localizedMonths,normalizeQueryPrefix,conceptRequests} from "./query-language";
import {amountSelection} from "./amount-search";

type Scope=TransactionFilters;
export type FinancialIntent=
  | {status:"ready";tool:"showTransactions";period:Period;scope:Scope}
  | {status:"ready";tool:"showDonut"|"showCategories"|"showBaskets"|"showProfile";period:Period}
  | {status:"ready";tool:"showWhatIf";period:Period;category:string;pct:number}
  | {status:"ready";tool:"showBenchmark";period:Period;category:string}
  | {status:"ready";tool:"peerComparison";period:Period;metric:import("@/engine/peer-comparison").PeerMetric}
  | {status:"ready";tool:"showSafeToSpend";purpose?:"spend"|"save"}
  | {status:"ready";tool:"showStepper"}
  | {status:"ready";tool:"showConcept";concept:"fund"|"safeConcept"|"savingConcept"|"cashflow"|"habit"|"basketConcept"|"regular"|"irregular"|"everyday"}
  | {status:"ready";tool:"showFilter";period:Period;value:"all"|"booked"|"reserved"|"reversed";scope:Scope}
  | {status:"ready";tool:"showDetails";period:Period}
  | {status:"unsupported"|"clarification_required";reason:string;retryQuestion?:string};

export function requestForIntent(intent:Extract<FinancialIntent,{status:"ready"}>) {
  const input:Record<string,unknown>="period" in intent ? {period:intent.period} : {};
  if(intent.tool==="showTransactions") Object.assign(input,intent.scope);
  if(intent.tool==="showWhatIf") Object.assign(input,{category:intent.category,pct:intent.pct});
  if(intent.tool==="showBenchmark") input.category=intent.category;
  if(intent.tool==="peerComparison") input.metric=intent.metric;
  if(intent.tool==="showConcept") input.concept=intent.concept;
  if(intent.tool==="showFilter") Object.assign(input,{value:intent.value},intent.scope);
  if(intent.tool==="showSafeToSpend" && intent.purpose!==undefined) input.purpose=intent.purpose;
  return {name:intent.tool,input};
}

const quoted='"(?:[^"\\\\]|\\\\["\\\\/bfnrt]|\\\\u[0-9a-fA-F]{4})*"';
const relative=/^(.*?) (last month|previous month|this month|last week|this week|viime kuussa|tässä kuussa|viime viikolla|tällä viikolla|eelmisel kuul|sel kuul|eelmisel nädalal|sel nädalal)$/iu;
const months=["january","february","march","april","may","june","july","august","september","october","november","december"];
const presetKeys:Key[]=["qTaxi","qProfile","qSafe","qSave","qWhatif","qDonut","qCompare","qBaskets","qLearn"];
function clean(value:string) {return value.trim().replace(/\?$/u,"").trim();}
/** Move one explicit month phrase to the grammar's suffix; quoted labels stay literal. */
function monthAtEnd(value:string):string {
  const pattern=new RegExp(`(?:^| )((?:(?:in|during|for) )?(?:${months.join("|")})(?: \\d{4})?|(?:${Object.keys(localizedMonths).join("|")})(?: \\d{4})?)(?=,? |$)`,"giu");
  const outside=[...value.matchAll(pattern)].filter(match=>{
    let quoted=false;for(let i=0;i<match.index!;i++){if(value[i]==="\\" && quoted)i++;else if(value[i]==='"')quoted=!quoted;}return !quoted;
  });
  if(outside.length!==1)return value;
  const match=outside[0],before=value.slice(0,match.index).trim(),after=value.slice(match.index!+match[0].length).replace(/^,? /u,"").trim();
  const phrase=match[1],english=new RegExp(`^(?:${months.join("|")})(?: \\d{4})?$`,"iu").test(phrase) ? `in ${phrase}` : phrase;
  return `${[before,after].filter(Boolean).join(" ")} ${english}`.trim();
}
function canonical(value:string,baseOnly=false):string {
  const comparison=clean(value).toLowerCase();
  for(const dictionary of Object.values(dictionaries)) for(const key of presetKeys) {
    const preset=clean(dictionary[key]),candidate=baseOnly ? preset.match(relative)?.[1] ?? preset : preset;
    if(candidate.toLowerCase()===comparison) {
      const english=clean(dictionaries.en[key]);
      return baseOnly ? english.match(relative)?.[1] ?? english : english;
    }
  }
  return normalizeQueryPrefix(value);
}
function advance(date:string,days:number) {
  const parsed=new Date(date+"T12:00:00Z");parsed.setUTCDate(parsed.getUTCDate()+days);
  return parsed.toISOString().slice(0,10);
}
function literal(value:string,max:number):string|null {
  try {const parsed=z.string().min(1).max(max).parse(JSON.parse(value));return /[\u0000-\u001f\u007f-\u009f]/u.test(parsed) || !parsed.trim() ? null : parsed;} catch {return null;}
}
function scope(value:string):Scope|null {
  let rest=value;const result:Scope={};
  const merchant=rest.match(new RegExp(`^(.*?) (?:at|paikassa|kaupmehelt) (${quoted})$`,"iu")) ?? rest.match(new RegExp(`^()(?:at|paikassa|kaupmehelt) (${quoted})$`,"iu"));
  if(merchant) {const name=literal(merchant[2],120);if(name===null) return null;result.merchant=name;rest=merchant[1];}
  const basket=rest.match(new RegExp(`^((?:in )?(?:basket|korissa|korvis) ${quoted})(?: (.+))?$`,"iu"));
  if(basket) {const selected=basketSelector(basket[1]);if(selected===null) return null;result.basket=selected;rest=basket[2] ?? "";}
  else {const selected=basketSelector(rest);if(selected!==null) {result.basket=selected;rest="";}}
  if(rest) {
    const category=rest.match(new RegExp(`^(?:in )?(?:category|kategoriassa|kategoorias) (${quoted})$`,"iu"));
    const name=category ? literal(category[1],80) : Object.hasOwn(categoryAliases,rest.toLowerCase()) ? categoryAliases[rest.toLowerCase()] : null;
    if(!name) return null;result.category=name;
  }
  return Object.keys(result).length ? result : null;
}

/** Fully consumed selectors only. The clock is the displayed fixture snapshot, never browser time. */
export function interpretQuestion(question:string,selected?:Period,referenceDate=snapshot):FinancialIntent {
  const snapshot=referenceDate,lastMonth=monthPeriod(snapshot,-1);
  const reject=(reason:string,clarify=true):FinancialIntent=>({status:clarify ? "clarification_required" : "unsupported",reason});
  if(!question.trim() || question.length>2000 || /[\u0000-\u001f\u007f-\u009f]/u.test(question)) return reject("INVALID_QUESTION",false);
  const amount=amountSelection(question);
  if(amount.present){
    if(!amount.valid)return reject("UNSUPPORTED_AMOUNT_FILTER");
    const base=interpretQuestion(amount.text,selected,referenceDate);
    return base.status==='ready' && base.tool==='showTransactions'
      ? {...base,scope:{...base.scope,...amount.bounds}} : reject("UNSUPPORTED_AMOUNT_FILTER");
  }
  const conceptKey=clean(question).toLowerCase();
  const concept=Object.hasOwn(conceptRequests,conceptKey) ? conceptRequests[conceptKey] : undefined;
  if(concept) return {status:"ready",tool:"showConcept",concept};
  let text=monthAtEnd(canonical(clean(question)));
  const guidance=text.match(/^what is safe for me to (spend|save)(?: this (?:week|month))?$/iu);
  if(guidance) return guidance[1].toLowerCase()==="save" ? {status:"ready",tool:"showSafeToSpend",purpose:"save"} : {status:"ready",tool:"showSafeToSpend"};
  if(/^(?:explain (?:an? )?|what is an? )emergency fund$/iu.test(text)) return {status:"ready",tool:"showConcept",concept:"fund"};
  if(/^explain safe to spend$/iu.test(text)) return {status:"ready",tool:"showConcept",concept:"safeConcept"};
  if(/^set a savings goal$/iu.test(text)) return {status:"ready",tool:"showStepper"};

  let period=selected ? periodSchema.parse(selected) : lastMonth,explicit=false;
  const localizedDates=text.match(/^(.*?) (?:ajalta|vahemikus) (\d{4}-\d{2}-\d{2})–(\d{4}-\d{2}-\d{2})$/iu);
  const dates=text.match(/^(.*?) from (\d{4}-\d{2}-\d{2}) (until|through) (\d{4}-\d{2}-\d{2})$/iu) ?? (localizedDates ? [localizedDates[0],localizedDates[1],localizedDates[2],"through",localizedDates[3]] : null);
  const day=text.match(/^(.*?) on (\d{4}-\d{2}-\d{2})$/iu);
  const named=text.match(relative);
  const calendar=text.match(new RegExp(`^(.*?) (?:in|during|for) (${months.join("|")})(?: (\\d{4}))?$`,"iu")) ?? text.match(new RegExp(`^(.*?) (${Object.keys(localizedMonths).join("|")})(?: (\\d{4}))?$`,"iu"));
  if(dates || day) {
    const raw=dates ? {start:dates[2],end:dates[4]} : {start:day![2],end:day![2]};
    if(!z.iso.date().safeParse(raw.start).success || !z.iso.date().safeParse(raw.end).success) return reject("INVALID_PERIOD");
    period={start:raw.start,end:day || dates![3].toLowerCase()==="through" ? advance(raw.end,1) : raw.end};
    text=(dates ?? day)![1];explicit=true;
  } else if(named) {
    const token=named[2].toLowerCase();text=named[1];explicit=true;
    if(["last month","previous month","viime kuussa","eelmisel kuul"].includes(token)) period=lastMonth;
    else if(["this month","tässä kuussa","sel kuul"].includes(token)) period=selected ?? {start:monthPeriod(snapshot).start,end:advance(snapshot,1)};
    else {
      const weekday=new Date(snapshot+"T12:00:00Z").getUTCDay(),monday=advance(snapshot,-((weekday+6)%7));
      period=["last week","viime viikolla","eelmisel nädalal"].includes(token) ? {start:advance(monday,-7),end:monday} : {start:monday,end:advance(snapshot,1)};
    }
  } else if(calendar) {
    const token=calendar[2].toLowerCase(),index=Object.hasOwn(localizedMonths,token) ? localizedMonths[token] : months.indexOf(token);
    const year=calendar[3] ?? snapshot.slice(0,4),month=String(index+1).padStart(2,"0");
    const first=`${year}-${month}-01`;
    if(!z.iso.date().safeParse(first).success) return reject("INVALID_PERIOD");
    period=monthPeriod(first);text=calendar[1];explicit=true;
  }
  if(!periodSchema.safeParse(period).success || period.end>advance(snapshot,1)) return calendar ? {status:"clarification_required",reason:"INVALID_PERIOD",retryQuestion:canonical(text,true)} : reject("INVALID_PERIOD");
  text=canonical(text,true);
  const peers=text.match(/^(?:compare me to people like me|am i spending more than others my age|võrdle mind minusugustega|kas kulutan rohkem kui minuvanused|vertaa minua kaltaisiini|kulutanko enemmän kuin ikäiseni)$/iu);
  if(peers)return {status:"ready",tool:"peerComparison",period,metric:"dining"};
  const peerCategory=text.match(/^(?:how does my (.+?) compare|compare my (.+?) (?:with|to) people like me|kuidas (.+?) teistega võrreldes on|võrdle (.+?) minuvanustega|miten (.+?) vertautuu ikäisiini|vertaa (.+?) ikäisiini)$/iu);
  if(peerCategory){const selected=scope(peerCategory.slice(1).find(Boolean)!.toLowerCase());const metric=selected?.basket??selected?.category;if(metric && !selected?.merchant)return {status:"ready",tool:"peerComparison",period,metric:metric as import("@/engine/peer-comparison").PeerMetric};return reject("AMBIGUOUS_CATEGORY");}
  if(/^(?:change|refine) period$/iu.test(text)) return {status:"ready",tool:"showDetails",period};
  const status=text.match(/^show (all|booked|reserved|reversed) transactions(?: (.+))?$/iu);
  if(status) {
    const parsed=status[2] ? scope(status[2]) : {};
    if(!parsed) return reject("AMBIGUOUS_FILTERS");
    return {status:"ready",tool:"showFilter",period,value:status[1].toLowerCase() as "all"|"booked"|"reserved"|"reversed",scope:parsed};
  }
  if(/^filter transactions$/iu.test(text)) return {status:"ready",tool:"showFilter",period,value:"all",scope:{}};
  if(/^where did my money go$/iu.test(text)) return {status:"ready",tool:"showDonut",period};
  if(/^what kind of spender (?:am|was) i$/iu.test(text)) return {status:"ready",tool:"showProfile",period};
  if(/^show my three baskets$/iu.test(text)) return {status:"ready",tool:"showBaskets",period};
  if(/^compare me to others$/iu.test(text)) return isCalendarMonth(period) ? {status:"ready",tool:"showBenchmark",period,category:"taxi"} : reject("MONTH_REQUIRED");
  const compare=text.match(/^compare (?:my )?(.+?) spending (?:to|with) (?:others|the population)$/iu);
  if(compare) {
    const parsed=scope(compare[1]);
    if(!parsed?.category || parsed.merchant || parsed.basket) return reject("AMBIGUOUS_CATEGORY");
    return isCalendarMonth(period) ? {status:"ready",tool:"showBenchmark",period,category:parsed.category} : reject("MONTH_REQUIRED");
  }

  const reduction=text.match(/^(?:what if i (?:cut|reduce)|how much could i save if i reduced|reduce) (.+?) by (\d{1,3}(?:[.,]\d{1,2})?)%$/iu);
  if(reduction) {
    const parsed=scope(reduction[1]),pct=Number(reduction[2].replace(",","."));
    if(pct>100) return reject("AMBIGUOUS_REDUCTION");
    if(!parsed?.category || parsed.merchant || parsed.basket) return reject(/\d%/u.test(reduction[1]) ? "AMBIGUOUS_REDUCTION" : "AMBIGUOUS_CATEGORY");
    if(!isCalendarMonth(period)) return {status:"clarification_required",reason:"MONTH_REQUIRED",retryQuestion:`What if I cut category ${JSON.stringify(parsed.category)} by ${pct}%`};
    return {status:"ready",tool:"showWhatIf",period,category:parsed.category,pct};
  }
  const spending=text.match(/^(?:how much did i spend|show (?:my )?spending)(?: (?:on )?(.+))?$/iu);
  const transactions=text.match(/^show (?:my )?transactions(?: (.+))?$/iu);
  if(spending || transactions) {
    const filter=(spending ?? transactions)![1];
    if(!filter) return transactions ? {status:"ready",tool:"showTransactions",period,scope:{}} : {status:"ready",tool:"showCategories",period};
    const parsed=scope(filter);return parsed ? {status:"ready",tool:"showTransactions",period,scope:parsed} : reject("AMBIGUOUS_FILTERS");
  }
  // An unconsumed period, second clause, amount or selector never becomes a best-effort query.
  return reject(explicit ? "UNSUPPORTED_FORMULATION" : "UNRESOLVED_QUESTION",false);
}
