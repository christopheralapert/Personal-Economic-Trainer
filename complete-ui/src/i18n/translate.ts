import {dictionaries,type Key,type Locale} from "./dictionaries";
export function translate(locale:Locale,key:Key,values:Record<string,string|number>={}) {
  return Object.entries(values).reduce((s,[key,value])=>s.replaceAll(`{${key}}`,String(value)),dictionaries[locale][key]);
}
const categories=new Set<Key>(["taxi","dining","coffee","housing","groceries","repairs","transfer","other","utilities","phone","insurance","salary","transport","health","home_tech","lifestyle","entertainment","travel","investment","other_income"]);
export function basketLabel(key:string,t:(key:Key)=>string):string {
  switch(key) {case "mandatory_regular":return t("regular");case "mandatory_irregular":return t("irregular");case "everyday":return t("everyday");case "unresolved":return t("unresolved");default:return key;}
}
export function categoryKey(key:string):Key {return categories.has(key as Key) ? key as Key : "other";}
/** Translate only known category identifiers. Source labels are plain text, never dictionary keys. */
export function categoryLabel(key:string,t:(key:Key)=>string):string {
  return key==="unclassified" ? t("notCategorised") : categories.has(key as Key) ? t(key as Key) : key;
}
