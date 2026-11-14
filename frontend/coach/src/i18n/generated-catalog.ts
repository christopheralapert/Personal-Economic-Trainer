import {en} from './dictionaries';
import {learningCopy} from './learning';
export const generatedCatalog:Record<string,string>={...en};
for(const [key,value] of Object.entries(learningCopy.en)){
 if(typeof value==='string')generatedCatalog[`learn.${key}`]=value;
 else for(const [part,text] of Object.entries(value))generatedCatalog[`learn.${key}.${part}`]=text;
}
Object.assign(generatedCatalog,{
 'conversation.confirm':'I’ll answer in {language}.',
 'conversation.thanks':'You’re welcome!',
 'speech.transactions':'Recorded net spending on {subject}: {amount}. Period: {period}.',
 'speech.chart':'Recorded spending in {period}: {amount}. Your biggest category was {first}, followed by {second}. These records are partial.',
 'speech.scenario':'Cutting {category} by {pct}% would reduce recorded spending by {amount} from a {baseline} baseline. Period: {period}.',
});
export function validLanguage(value:unknown):string|null {
 if(typeof value!=='string'||value.length>35||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value))return null;
 try{const code=Intl.getCanonicalLocales(value)[0],base=new Intl.Locale(code).language,name=new Intl.DisplayNames(['en'],{type:'language'}).of(base);return name && name!==base?code:null;}catch{return null;}
}
export function checkedTranslations(keys:string[],candidate:unknown):Record<string,string>{
 if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw Error('translation_shape');
 const values=candidate as Record<string,unknown>;
 if(Object.keys(values).length!==keys.length||Object.keys(values).some(key=>!keys.includes(key)))throw Error('translation_keys');
 const tokens=(text:string)=>[...text.matchAll(/\{[\w]+\}/gu)].map(m=>m[0]).sort().join('|');
 const numbers=(text:string)=>(text.match(/\d+(?:[.,]\d+)*/gu)??[]).sort().join('|');
 for(const key of keys){const value=values[key];if(!Object.hasOwn(generatedCatalog,key)||typeof value!=='string'||!value.trim()||value.length>4000||/[<>\u0000-\u0008]/u.test(value)||tokens(value)!==tokens(generatedCatalog[key])||numbers(value)!==numbers(generatedCatalog[key]))throw Error('translation_shape');}
 return values as Record<string,string>;
}
