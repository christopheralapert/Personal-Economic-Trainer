import {coachFetch,COACH_REVISION} from '@/coach/transport';
import {generatedCatalog,checkedTranslations,validLanguage} from './generated-catalog';
const cache=new Map<string,{copy:Record<string,string>;untranslated:number}>();
export async function loadGeneratedLanguage(language:string,signal:AbortSignal,onProgress:(done:number,total:number)=>void){
 if(!validLanguage(language))throw Error('invalid_language');
 const keys=Object.keys(generatedCatalog),storageKey=`money-coach-generated.${COACH_REVISION}.${language}`;
 try{if(!cache.has(language)){const raw=localStorage.getItem(storageKey);if(raw&&raw.length<1000000){const saved=JSON.parse(raw);if(Number.isInteger(saved.untranslated)&&saved.untranslated>=0)cache.set(language,{copy:checkedTranslations(keys,saved.copy),untranslated:saved.untranslated});}}}catch{}
 if(cache.has(language))return cache.get(language)!;
 const translations:Record<string,string>={};
 for(let i=0;i<keys.length;i+=32){if(signal.aborted)throw Error('cancelled');const batch=keys.slice(i,i+32),response=await coachFetch('/api/language',{method:'POST',headers:{'Content-Type':'application/json','X-Money-Coach-Privacy':'off'},body:JSON.stringify({language,keys:batch}),signal});if(!response.ok)throw Error('translation_unavailable');const value=await response.json();Object.assign(translations,checkedTranslations(batch,value.translations));onProgress(Math.min(i+32,keys.length),keys.length);}
 if(signal.aborted)throw Error('cancelled');
 const result={copy:translations,untranslated:keys.filter(key=>translations[key]===generatedCatalog[key]&&/[a-z]{3} /iu.test(generatedCatalog[key])).length};
 cache.set(language,result);try{localStorage.setItem(storageKey,JSON.stringify(result));}catch{}return result;
}
