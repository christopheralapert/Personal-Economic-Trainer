import type {ConversationLanguage} from "@/coach/conversation-language";

/**
 * Make on-screen answer text sound natural when read aloud: "1 390,20 €" becomes
 * "1390 euros 20 cents", "1.9.2026" becomes "1 September 2026", separators become pauses.
 * Only the spoken form changes; the figures are the same validated values.
 */
const money:Record<ConversationLanguage,{euros:(n:string)=>string;cents:(n:string)=>string;and:string;minus:string;to:string}>={
 en:{euros:n=>`${n} ${n==="1"?"euro":"euros"}`,cents:n=>`${Number(n)} ${n==="01"?"cent":"cents"}`,and:" ",minus:"minus ",to:" to "},
 fi:{euros:n=>`${n} ${n==="1"?"euro":"euroa"}`,cents:n=>`${Number(n)} ${n==="01"?"sentti":"senttiä"}`,and:" ",minus:"miinus ",to:" – "},
 et:{euros:n=>`${n} ${n==="1"?"euro":"eurot"}`,cents:n=>`${Number(n)} ${n==="01"?"sent":"senti"}`,and:" ",minus:"miinus ",to:" kuni "},
 de:{euros:n=>`${n} Euro`,cents:n=>`${Number(n)} Cent`,and:" und ",minus:"minus ",to:" bis "},
 sv:{euros:n=>`${n} euro`,cents:n=>`${Number(n)} cent`,and:" och ",minus:"minus ",to:" till "},
 es:{euros:n=>`${n} ${n==="1"?"euro":"euros"}`,cents:n=>`${Number(n)} ${n==="01"?"céntimo":"céntimos"}`,and:" con ",minus:"menos ",to:" a "},
 ja:{euros:n=>`${n}ユーロ`,cents:n=>`${Number(n)}セント`,and:"",minus:"マイナス",to:"から"},
};
const intlLocale:Record<ConversationLanguage,string>={en:"en-GB",fi:"fi-FI",et:"et-EE",de:"de-DE",sv:"sv-SE",es:"es-ES",ja:"ja-JP"};
export function speechText(text:string,language:ConversationLanguage):string {
 const words=money[language],format=new Intl.DateTimeFormat(intlLocale[language],{day:"numeric",month:"long",year:"numeric",timeZone:"UTC"});
 return text
  .replace(/(?:([−-])\s?)?(\d{1,3}(?:[\u00a0\u202f ]\d{3})*|\d+),(\d{2})[\u00a0\u202f ]?€/gu,(_match,sign:string|undefined,whole:string,cents:string)=>{
   const euros=whole.replace(/[\u00a0\u202f ]/gu,"");
   return (sign ? words.minus : "")+words.euros(euros)+(cents==="00" ? "" : words.and+words.cents(cents));
  })
  .replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/gu,(match,day:string,month:string,year:string)=>{
   const date=new Date(Date.UTC(Number(year),Number(month)-1,Number(day),12));
   return date.getUTCDate()===Number(day) ? format.format(date) : match;
  })
  .replace(/\s*[–—]\s*/gu,words.to)
  .replace(/\s*·\s*/gu,", ")
  .replace(/\s{2,}/gu," ")
  .trim();
}
type VoiceLike={lang:string;name:string;localService:boolean;default?:boolean};
/** Prefer the exact regional voice, then natural/neural voices, then the browser default. */
export function preferredVoice<T extends VoiceLike>(voices:T[],language:ConversationLanguage,region:string,localOnly:boolean):T|undefined {
 const score=(voice:T)=>(voice.lang.toLowerCase()===region.toLowerCase() ? 4 : 0)+(/natural|neural|premium|enhanced|online/iu.test(voice.name) ? 2 : 0)+(voice.default ? 1 : 0);
 return voices.filter(voice=>voice.lang.toLowerCase().split("-")[0]===language && (!localOnly || voice.localService===true)).sort((a,b)=>score(b)-score(a))[0];
}
