function validLanguage(value:string):string|null {
 if(value.length>35||!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u.test(value))return null;
 try{const code=Intl.getCanonicalLocales(value)[0],base=new Intl.Locale(code).language,name=new Intl.DisplayNames(['en'],{type:'language'}).of(base);return name&&name!==base?code:null;}catch{return null;}
}
let names:Map<string,string>|undefined;
/** Match only explicit application-language commands, never financial questions. */
export function appLanguageCommand(text:string):string|null {
 const match=text.trim().match(/^(?:please\s+)?(?:switch|change|set) (?:the )?(?:whole |entire )?app(?:lication)?(?: language)?(?: back)? (?:to|into) (.+?)[.!]?$/iu)
  ??text.trim().match(/^(?:muuda|vaheta) kogu (?:äpi|rakenduse) keel (.+?)[.!]?$/iu);
 if(!match)return null;const target=match[1].trim();const code=validLanguage(target.toLowerCase());if(code)return code;
 if(!names){names=new Map();for(const ui of ['en','et','fi','es','ja']){const display=new Intl.DisplayNames([ui],{type:'language'});for(let a=97;a<=122;a++)for(let b=97;b<=122;b++){const key=String.fromCharCode(a,b),name=display.of(key);if(name&&name!==key)names.set(name.toLocaleLowerCase(),key);}}}
 return names.get(target.toLocaleLowerCase())??null;
}
