import {conversationLanguage,type ConversationLanguage} from '@/coach/conversation-language';
const endings:Record<ConversationLanguage,RegExp>={en:/(?:^|[.!?]\s+)(thank you)[.!?\s]*$/iu,fi:/(?:^|[.!?]\s+)(kiitos)[.!?\s]*$/iu,et:/(?:^|[.!?]\s+)(tänan|aitäh)[.!?\s]*$/iu,de:/(?:^|[.!?]\s+)(danke)[.!?\s]*$/iu,sv:/(?:^|[.!?]\s+)(tack)[.!?\s]*$/iu,es:/(?:^|[.!?]\s+)(gracias)[.!?\s]*$/iu,ja:/(?:^|[。！？.!?]\s*)(ありがとう(?:ございます)?)[。！\s]*$/u};
/** Only a separate final utterance is a command. Ambiguous unpunctuated text remains editable. */
export function dictationCommand(text:string,active:ConversationLanguage,detected?:string){
 const language=conversationLanguage(detected?.toLowerCase().split('-')[0],active),value=text.trim(),match=endings[language].exec(value);
 if(!match)return {text:value,send:false,command:false};
 const question=value.slice(0,match.index).trim();
 return {text:question,send:question.length>0,command:true};
}
export const dictationHint:Record<ConversationLanguage,string>={en:'Say “thank you” as a separate final sentence to send. Otherwise stop, edit and send.',de:'Sag zum Senden „danke“ als eigenen letzten Satz. Sonst stoppen, bearbeiten und senden.',sv:'Säg ”tack” som en separat sista mening för att skicka. Annars stoppa, redigera och skicka.',fi:'Sano lopuksi erikseen ”kiitos” lähettääksesi. Muuten lopeta, muokkaa ja lähetä.',et:'Saatmiseks ütle lõpus eraldi „tänan”. Muidu lõpeta, muuda ja saada.',es:'Di «gracias» en una frase separada al final para enviar. Si no, detén, edita y envía.',ja:'最後に「ありがとう」と別の文で言うと送信します。それ以外は停止して、編集してから送信してください。'};
