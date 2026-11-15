import {copyLocale} from "@/i18n/dictionaries";
import {periodSchema,transactionFiltersSchema,type Period,type TransactionFilters} from "@/engine";
import {translate} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";

/** Closed localized grammar with quoted literals; unsupported source labels remain display-only. */
export function transactionQuestion(period:Period,filters:TransactionFilters,locale:Locale):string|null {
  if(!periodSchema.safeParse(period).success || !transactionFiltersSchema.safeParse(filters).success || Object.values(filters).some(value=>typeof value==='string' && /[\u0000-\u001f\u007f-\u009f]/u.test(value))) return null;
  const through=new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10);
  const parts=[translate(locale,"queryTransactions")];
  if(filters.basket!==undefined) parts.push(translate(locale,"queryBasket",{value:JSON.stringify(filters.basket)}));
  if(filters.category!==undefined) parts.push(translate(locale,"queryCategory",{value:JSON.stringify(filters.category)}));
  if(filters.merchant!==undefined) parts.push(translate(locale,"queryMerchant",{value:JSON.stringify(filters.merchant)}));
  const exact=(minor:number)=>`${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`;
  if(filters.amount_min_minor!==undefined)parts.push(`${{en:'at least',fi:'vähintään',et:'vähemalt'}[copyLocale(locale)]} EUR ${exact(filters.amount_min_minor)}`);
  if(filters.amount_max_minor!==undefined)parts.push(`${{en:'at most',fi:'enintään',et:'kuni'}[copyLocale(locale)]} EUR ${exact(filters.amount_max_minor)}`);
  parts.push(translate(locale,"queryPeriod",{start:period.start,end:through}));
  return parts.join(" ");
}
