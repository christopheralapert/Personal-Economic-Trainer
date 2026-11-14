import {propsSchemas,type ToolName} from "./catalog";
import {answerFromTool,answerBasis} from "./answer";
import {monthPeriod,exactSum,periodSchema,type Period} from "@/engine";
import {date,money} from "@/lib/format";
import {translate,categoryLabel,basketLabel} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";
import type {ConversationLanguage} from './conversation-language';

/** One authored sentence for the screen and speech, derived only from checked tools. */
export function spokenAnswer(name:ToolName,input:Record<string,unknown>,output:unknown,locale:ConversationLanguage):string {
 if(locale==='es' || locale==='ja')return internationalAnswer(name,input,output,locale);
 const t=(key:Parameters<typeof translate>[1],values?:Record<string,string|number>)=>translate(locale,key,values);
 function periodText(period:Period) {
  const start=new Date(period.start+"T12:00:00Z"),fullMonth=period.start.endsWith("-01") && monthPeriod(period.start).end===period.end;
  const fiMonths=["tammikuussa","helmikuussa","maaliskuussa","huhtikuussa","toukokuussa","kesäkuussa","heinäkuussa","elokuussa","syyskuussa","lokakuussa","marraskuussa","joulukuussa"];
  if(fullMonth)return locale==="fi" ? `${fiMonths[start.getUTCMonth()]} ${start.getUTCFullYear()}` : new Intl.DateTimeFormat(locale==="en" ? "en-GB" : "et-EE",{month:"long",year:"numeric",timeZone:"UTC"}).format(start);
  return `${date(period.start)}–${date(new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10))}`;
 }
 if(name==="showDetails" || name==="showDonut") {
  const result=propsSchemas[name].parse(output);
  if(!result.groups.length)return t('noExpenseRecords');
  const total=t("spokenAllSpending",{amount:money(exactSum(result.groups.map(group=>group.amount))),period:periodText(result.period)});
  const top=[...result.groups].filter(group=>group.amount>0 && !['other_categories','otherCategories','__other__'].includes(group.key)).sort((a,b)=>b.amount-a.amount).slice(0,2).map(group=>`${categoryLabel(group.key,t)} (${money(group.amount)})`);
  const leading=top.length ? locale==='en'?` Your biggest category was ${top.join(', followed by ')}.`:locale==='fi'?` Suurin kategoriasi oli ${top.join(', seuraavana ')}.`:` Sinu suurim kategooria oli ${top.join(', järgnes ')}.`:'';
  return total+leading+(locale==='en'?' These records are partial.':locale==='fi'?' Tiedot ovat osittaiset.':' Andmed on osalised.');
 }
 if(name==='showWhatIf'){
  const result=propsSchemas.showWhatIf.parse(output),{pct,monthly,baseline}=result.result,category=categoryLabel(result.category,t),period=periodText(result.period);
  return locale==='en'?`Cutting ${category} by ${pct}% would reduce recorded spending by ${money(monthly)} from a ${money(baseline)} baseline. Period: ${period}.`:locale==='fi'?`${category}: ${pct} % vähennys pienentäisi kirjattuja menoja ${money(monthly)} lähtösummasta ${money(baseline)}. Ajanjakso: ${period}.`:`${category}: ${pct}% vähendus vähendaks kirjendatud kulu ${money(monthly)} võrra baassummast ${money(baseline)}. Periood: ${period}.`;
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

/** Authored ES/JA framing uses validated results, never translated financial figures. */
function internationalAnswer(name:ToolName,input:Record<string,unknown>,output:unknown,locale:'es'|'ja'):string{
 const checked=propsSchemas[name].parse(output),record=checked as Record<string,unknown>,parsed=periodSchema.safeParse(record.period??input.period);
 const period=parsed.success?(parsed.data.start.endsWith('-01')&&monthPeriod(parsed.data.start).end===parsed.data.end?new Intl.DateTimeFormat(locale==='es'?'es-ES':'ja-JP',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(parsed.data.start+'T12:00:00Z')):`${parsed.data.start}–${new Date(Date.parse(parsed.data.end+'T12:00:00Z')-86400000).toISOString().slice(0,10)}`):'';
 const label=(key:string)=>({es:{taxi:'taxis',dining:'restaurantes',housing:'Hogar',entertainment:'Entretenimiento'},ja:{taxi:'タクシー',dining:'外食',housing:'住居',entertainment:'娯楽'}}[locale] as Record<string,string>)[key]??key;
 if(name==='showTransactions'){
  const result=propsSchemas.showTransactions.parse(output);if(result.total===0)return locale==='es'?`No hay transacciones registradas en ${period}.`:`${period}に記録された取引はありません。`;
  if(result.netExpenses===null)return locale==='es'?'No hay gastos confirmados.':'確認された支出はありません。';
  const subject=result.filters.category?label(result.filters.category):locale==='es'?'la selección':'選択した範囲';
  return locale==='es'?`Gastaste ${money(result.netExpenses)} en ${subject} en ${period}.`:`${period}の${subject}の支出は${money(result.netExpenses)}でした。`;
 }
 if(name==='showWhatIf'){
  const r=propsSchemas.showWhatIf.parse(output).result;
  return locale==='es'?`Reducir ${label(r.category)} un ${r.pct}% bajaría el gasto en ${money(r.monthly)}, desde ${money(r.baseline)} en ${period}.`:`${period}の${label(r.category)}を${r.pct}%減らすと、${money(r.baseline)}から${money(r.monthly)}の削減になります。`;
 }
 if(name==='showDonut' || name==='showDetails' || name==='showCategories'){
  const r=propsSchemas[name].parse(output),amount=money(exactSum(r.groups.map(g=>g.amount))),top=[...r.groups].filter(g=>g.amount>0).sort((a,b)=>b.amount-a.amount).slice(0,2).map(g=>`${label(g.key)} (${money(g.amount)})`).join(locale==='es'?' y ':'、');
  return locale==='es'?`El gasto registrado en ${period} fue ${amount}. Las categorías más grandes fueron ${top}; los datos son parciales.`:`${period}の記録された支出は${amount}です。最大のカテゴリーは${top}で、データは一部のみです。`;
 }
 return locale==='es'?'Estos resultados usan los datos registrados. Los detalles de esta vista aún están disponibles en el idioma de la aplicación.':'記録されたデータに基づく結果です。この表示の詳細は現在、アプリの言語で表示されます。';
}
