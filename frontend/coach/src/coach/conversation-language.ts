import {copyLocale} from "@/i18n/dictionaries";
import type {Locale} from '@/i18n/dictionaries';

// Conversation languages are intentionally independent of the Settings menu.
export const conversationLanguages=['en','fi','et','de','sv','es','ja'] as const;
export type ConversationLanguage=typeof conversationLanguages[number];
export const speechLanguages={en:'en-US',fi:'fi-FI',et:'et-EE',de:'de-DE',sv:'sv-SE',es:'es-ES',ja:'ja-JP'} as const;
export function conversationLanguage(value:unknown,fallback:ConversationLanguage='en'):ConversationLanguage {
 return conversationLanguages.includes(value as ConversationLanguage)?value as ConversationLanguage:fallback;
}
const names:Record<ConversationLanguage,RegExp>={en:/english|inglise(?: keeles| keelele)?|englanniksi/iu,fi:/finnish|soome(?: keeles)?|suomeksi/iu,et:/estonian|eesti(?: keeles)?|viroksi/iu,de:/german|deutsch|saksaksi|saksa(?: keeles)?/iu,sv:/swedish|svenska|ruotsiksi|rootsi(?: keeles)?/iu,es:/spanish|hispaania(?: keeles| keelele)?|español|espanjaksi/iu,ja:/japanese|jaapani(?: keeles| keelele)?|日本語|japaniksi/iu};
export function languageCommand(text:string){
 const match=text.trim().match(/^(?:(?:please|palun)\s+)?(?:answer|reply|respond|speak|vasta|vastaa|responde|switch|change|muuda)\b[^?!;\n]*?(?:english|finnish|estonian|german|swedish|deutsch|svenska|saksaksi|ruotsiksi|spanish|japanese|inglise(?: keeles| keelele)?|soome(?: keeles)?|eesti(?: keeles)?|hispaania(?: keeles| keelele)?|jaapani(?: keeles| keelele)?|suomeksi|englanniksi|viroksi|espanjaksi|japaniksi|español|日本語)(?:\s+(?:from now on|for this conversation|for this answer))?[.!,:;\s]*/iu);
 if(!match)return null;
 const language=conversationLanguages.find(key=>names[key].test(match[0]));if(!language)return null;
 return {language,scope:/whole app|entire app|kogu (?:äpp|rakendus)|koko sovellus/iu.test(match[0])?'app' as const:/edaspidi|from now on|for this conversation|always|jätkossa/iu.test(match[0])?'conversation' as const:'answer' as const,question:text.trim().slice(match[0].length).trim()};
}
export const languageConfirmation:Record<ConversationLanguage,string>={en:'I’ll answer in English.',fi:'Vastaan suomeksi.',et:'Vastan eesti keeles.',de:'Ich antworte auf Deutsch.',sv:'Jag svarar på svenska.',es:'Responderé en español.',ja:'日本語で回答します。'};
export function acknowledgement(text:string,language:ConversationLanguage):string|null {
 if(!/^(?:thank(?:s| you)(?: very much)?|tänan|aitäh|kiitos|danke(?: schön)?|tack(?: så mycket)?|gracias|ありがとう(?:ございます)?)[.!。！\s]*$/iu.test(text.trim()))return null;
 return {en:'You’re welcome!',fi:'Ole hyvä!',et:'Hea meelega!',de:'Gern geschehen!',sv:'Varsågod!',es:'¡De nada!',ja:'どういたしまして。'}[language];
}
export function localLanguageUnavailable(locale:Locale){return {en:'Local Coach supports English, Finnish and Estonian. Turn Privacy mode off for this conversation language, or ask in one of those languages.',fi:'Paikallinen Coach tukee englantia, suomea ja viroa. Poista yksityisyystila käytöstä tätä keskustelukieltä varten tai käytä tuettua kieltä.',et:'Kohalik Coach toetab inglise, soome ja eesti keelt. Selle vestluskeele jaoks lülita privaatsusrežiim välja või kasuta toetatud keelt.'}[copyLocale(locale)];}
export const appLanguageConfirmation:Record<Locale,string>={en:'Interface language: English.',fi:'Käyttöliittymän kieli: suomi.',et:'Kasutajaliidese keel: eesti.',de:'Sprache der Oberfläche: Deutsch.',sv:'Gränssnittets språk: svenska.'};
export function appLanguageUnavailable(locale:Locale){return {en:'The interface supports English, Finnish and Estonian. Choose one in Settings. You can ask Coach to reply in another language without changing the interface.',fi:'Käyttöliittymä tukee englantia, suomea ja viroa. Valitse kieli asetuksista. Voit pyytää Coachia vastaamaan toisella kielellä muuttamatta käyttöliittymää.',et:'Kasutajaliides toetab inglise, soome ja eesti keelt. Vali keel seadetes. Võid paluda Coachil vastata teises keeles ilma kasutajaliidest muutmata.'}[copyLocale(locale)];}
export function answerLanguage(metadata:unknown,fallback:ConversationLanguage){return conversationLanguage(metadata && typeof metadata==='object' && 'language' in metadata?metadata.language:undefined,fallback);}
