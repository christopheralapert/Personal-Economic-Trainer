/** Explicit EUR magnitude predicates only. Quoted merchant names remain literal data. */
export type AmountSelection={text:string;present:boolean;valid:boolean;bounds:{amount_min_minor?:number;amount_max_minor?:number}};
const operator='at least|at most|more than|greater than|less than|over|above|under|below|yli|alle|vähintään|enintään|üle|alla|vähemalt|kuni|>=|<=|>|<';
const number='[0-9]{1,16}(?:[.,][0-9]{1,2})?';
const unit='EUR|€|euron|euroa|eurot|euros?|euro';
const candidate=new RegExp(`(?<![\\p{L}0-9_])(?:${operator})\\s*[+−-]?\\s*(?:(?:[A-Z]{3}|[€$£])\\s*)?[+−-]?[0-9]`,'iu');
const mask=(text:string)=>text.replace(/"(?:\\.|[^"\\])*"/gu,value=>' '.repeat(value.length)).replace(/\bkuni (?=\d{4}-\d{2}-\d{2}\b)/giu,'     ');
function normalize(text:string):string {
 text=text.trim().replace(/[?.]$/u,'').trim().split(/("(?:\\.|[^"\\])*")/gu).map((part,index)=>index%2?part:part.replace(/\s+/gu,' ')).join('');
 const localized=text.match(/^(?:näytä|näita) (?:viime kuun|eelmise kuu) (.+)$/iu);
 if(localized)return `Show transactions ${localized[1]} last month`;
 const english=text.match(/^(?:show|list|find) (?:me )?(last month's|this month's) (.+?) (?:rides|transactions)(.*)$/iu);
 if(english)return `Show transactions ${english[2]}${english[3]} ${english[1].toLowerCase()==="last month's"?'last month':'this month'}`;
 return text;
}
export function amountSelection(question:string):AmountSelection {
 const masked=mask(question);
 const result:AmountSelection={text:question,present:candidate.test(masked)||/\b(?:between|välillä)\s*[€$£]?\s*\d/iu.test(masked),valid:false,bounds:{}};
 if(!result.present)return result;
 const pattern=new RegExp(`(?<![\\p{L}0-9])(${operator})\\s*(?:(?:EUR|€)\\s*(${number})|(${number})\\s*(?:${unit}))(?=$|\\s|[?!.,])`,'giu');
 const matches=[...masked.matchAll(pattern)];
 if(matches.length<1||matches.length>2)return result;
 let text=question;
 for(const match of matches){
  const [whole,fraction='']=(match[2]??match[3]).replace(',','.').split('.');
  let cents=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
  const op=match[1].toLowerCase(),lower=['over','above','more than','greater than','yli','üle','>','at least','vähintään','vähemalt','>='].includes(op);
  const inclusive=['at least','at most','vähintään','enintään','vähemalt','kuni','>=','<='].includes(op);
  if(!inclusive)cents+=lower?1n:-1n;
  if(cents<0n||cents>BigInt(Number.MAX_SAFE_INTEGER))return result;
  const key=lower?'amount_min_minor':'amount_max_minor';
  if(result.bounds[key]!==undefined)return result;
  result.bounds[key]=Number(cents);
 }
 for(const match of [...matches].reverse())text=text.slice(0,match.index)+text.slice(match.index!+match[0].length);
 // Only remove a connector sitting BETWEEN the two consumed predicates.
 if(matches.length===2){const gap=masked.slice(matches[0].index!+matches[0][0].length,matches[1].index);if(!/^\s*(?:and|ja)?\s*$/iu.test(gap))return result;text=question.slice(0,matches[0].index)+question.slice(matches[1].index!+matches[1][0].length);}
 const remaining=mask(text);
 if(candidate.test(remaining)||/[<>]|\b(?:or|between|välillä)\b/iu.test(remaining))return result;
 if((result.bounds.amount_min_minor??0)>(result.bounds.amount_max_minor??Number.MAX_SAFE_INTEGER))return result;
 result.text=normalize(text);result.valid=true;return result;
}
