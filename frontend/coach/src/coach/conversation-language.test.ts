import {describe,it,expect} from 'vitest';
import {languageCommand,acknowledgement,appLanguageUnavailable,appLanguageConfirmation} from './conversation-language';
import {dictationCommand} from '@/voice/dictation-command';
import {appLanguageCommand} from './app-language-command';
describe('conversation controls independent of the UI language',()=>{
 it('recognizes unsupported application-language requests without treating them as financial queries',()=>{
  expect(appLanguageCommand('Switch the whole app to Hindi')).toBe('hi');expect(appLanguageCommand('Switch the whole app to Japanese')).toBe('ja');expect(appLanguageCommand('Switch the whole app to zh-CN')).toBe('zh-CN');expect(appLanguageCommand('Show Japanese restaurant payments')).toBeNull();
 });
 it('offers reviewed interface languages without promising live UI generation',()=>{
  for(const locale of ['en','fi','et'] as const){expect(appLanguageConfirmation[locale]).toBeTruthy();expect(appLanguageUnavailable(locale)).not.toMatch(/AI|tehis|tekoäly/iu);}
  expect(appLanguageUnavailable('en')).toContain('without changing the interface');
 });
 it('keeps one-answer, conversation and application scopes distinct',()=>{
  expect(languageCommand('Vasta sellele hispaania keeles. How much did I spend on taxis last month?')).toEqual({language:'es',scope:'answer',question:'How much did I spend on taxis last month?'});
  expect(languageCommand('Vasta edaspidi jaapani keeles')).toEqual({language:'ja',scope:'conversation',question:''});
  expect(languageCommand('Switch the whole app back to English')).toEqual({language:'en',scope:'app',question:''});
  expect(languageCommand('Show Spanish restaurant transactions')).toBeNull();
 });
 for(const [language,thanks,question] of [['en','thank you','How much did I spend on taxis?'],['fi','kiitos','Paljonko käytin takseihin?'],['et','tänan','Kui palju kulutasin taksole?'],['es','gracias','¿Cuánto gasté en taxis?'],['ja','ありがとう','タクシーにいくら使いましたか。']] as const){
  it(`${language}: only a separate trailing voice command sends`,()=>{
   expect(dictationCommand(`${question} ${thanks}`,language)).toEqual({text:question.slice(0,-1),send:true,command:true});
   expect(dictationCommand(thanks,language)).toEqual({text:'',send:false,command:true});
   expect(dictationCommand(`${thanks}, ${question}`,language).command).toBe(false);
   expect(acknowledgement(thanks,language)).toBeTruthy();
   expect(dictationCommand(`Find ${thanks} payments`,language).send).toBe(false);
  });
 }
 it('uses a recognized speech language when returned',()=>expect(dictationCommand('Taxi question. Gracias.','en','es-ES')).toEqual({text:'Taxi question',send:true,command:true}));
});
