import {propsSchemas,type ToolName} from "./catalog";
import {answerFromTool,answerBasis} from "./answer";
import {monthPeriod,exactSum,periodSchema,type Period} from "@/engine";
import {date,money} from "@/lib/format";
import {translate,categoryLabel,basketLabel} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";

/** One authored sentence for the screen and speech, derived only from checked tools. */
export function spokenAnswer(name:ToolName,input:Record<string,unknown>,output:unknown,locale:Locale):string {
 const t=(key:Parameters<typeof translate>[1],values?:Record<string,string|number>)=>translate(locale,key,values);
 function periodText(period:Period) {
  const start=new Date(period.start+"T12:00:00Z"),fullMonth=period.start.endsWith("-01") && monthPeriod(period.start).end===period.end;
  const fiMonths=["tammikuussa","helmikuussa","maaliskuussa","huhtikuussa","toukokuussa","kesäkuussa","heinäkuussa","elokuussa","syyskuussa","lokakuussa","marraskuussa","joulukuussa"];
  if(fullMonth)return locale==="fi" ? `${fiMonths[start.getUTCMonth()]} ${start.getUTCFullYear()}` : new Intl.DateTimeFormat(locale==="en" ? "en-GB" : "et-EE",{month:"long",year:"numeric",timeZone:"UTC"}).format(start);
  return `${date(period.start)}–${date(new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10))}`;
 }
 if(name==="showDetails" || name==="showDonut") {
  const result=propsSchemas[name].parse(output);
  return result.groups.length ? t("spokenAllSpending",{amount:money(exactSum(result.groups.map(group=>group.amount))),period:periodText(result.period)}) : t("noExpenseRecords");
 }
 if(name==="showFilter") {
  const result=propsSchemas.showFilter.parse(output);
  return result.total===0 ? t("emptyRecords") : result.netExpenses===null ? t("noExpenseRecords") : t("spokenAllSpending",{amount:money(result.netExpenses),period:periodText(result.period)});
 }
 if(name!=="showTransactions") {
  const first=answerFromTool(name,input,output,locale).parts.find(part=>part.type==="text");
  return first?.type==="text" ? first.text+(periodSchema.safeParse(input.period).success ? " "+answerBasis(input,locale) : "") : "";
 }
 const history=propsSchemas.showTransactions.parse(output),{period,filters}=history;
 if(history.total===0)return t("emptyRecords");
 if(history.netExpenses===null)return t("noExpenseRecords");
 const subject=filters.merchant??(filters.category ? categoryLabel(filters.category,t) : filters.basket ? basketLabel(filters.basket,t) : t("all"));
 return filters.category==="taxi" && locale==="fi" ? t("taxiPeriodSentence",{amount:money(history.netExpenses),period:periodText(period)}) : t("spokenSpending",{subject,amount:money(history.netExpenses),period:periodText(period)});
}
