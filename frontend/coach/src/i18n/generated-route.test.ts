import {it,expect,vi} from 'vitest';
import {createTranslationRoute} from './generated-route';
import {COACH_REVISION,REVISION_HEADER} from '@/coach/transport';
import {checkedTranslations,validLanguage,generatedCatalog} from './generated-catalog';
const origin='http://127.0.0.1:33134',env={VERDA_INFERENCE_KEY:'synthetic-test-key',MONEY_COACH_GENERATED_LANGUAGES_ENABLED:'true',MONEY_COACH_PUBLIC_AI_ORIGINS:origin};
const request=(privacy='off',body:unknown={language:'es',keys:['coach','learn']})=>new Request(origin+'/api/language',{method:'POST',headers:{origin,host:new URL(origin).host,'content-type':'application/json','X-Money-Coach-Privacy':privacy,[REVISION_HEADER]:COACH_REVISION},body:JSON.stringify(body)});
it('sends only server-owned UI copy and caches validated translations',async()=>{
 const network=vi.fn<typeof fetch>(async()=>Response.json({choices:[{message:{tool_calls:[{function:{name:'translate_ui',arguments:JSON.stringify({label_0:'Asesor',label_1:'Aprender'})}}]}}]}));
 const route=createTranslationRoute({env,network});expect((await route(request())).status).toBe(200);expect((await route(request())).status).toBe(200);expect(network).toHaveBeenCalledTimes(1);
 const body=JSON.parse(network.mock.calls[0][1]!.body as string),payload=JSON.parse(body.messages[1].content);expect(payload).toEqual({language:'es',source:{label_0:'Coach',label_1:'Learn'}});expect(JSON.stringify(body)).not.toMatch(/accountId|merchant|transactions|3097/);
});
it('privacy, unknown keys and invalid translations fail closed',async()=>{
 const network=vi.fn<typeof fetch>();const route=createTranslationRoute({env,network});expect((await route(request('on'))).status).toBe(403);expect((await route(request('off',{language:'es',keys:['private.ledger']}))).status).toBe(400);expect(network).not.toHaveBeenCalled();
 expect(()=>checkedTranslations(['spokenSpending'],{spokenSpending:'Wrong {invented}'})).toThrow();expect(()=>checkedTranslations(['coach'],{coach:'<script>alert()</script>'})).toThrow();expect(validLanguage('ja')).toBe('ja');expect(validLanguage('hi')).toBe('hi');expect(validLanguage('../../secret')).toBeNull();
});
it('preserves protected values and marks individual invalid translations as English fallbacks',async()=>{
 const network=vi.fn<typeof fetch>(async()=>Response.json({choices:[{message:{tool_calls:[{function:{name:'translate_ui',arguments:JSON.stringify({label_0:'<script>bad</script>',label_1:'Aprender',label_2:'Lost amount and period'})}}]}}]}));
 const response=await createTranslationRoute({env,network})(request('off',{language:'es',keys:['coach','learn','spokenSpending']}));expect(response.status).toBe(200);
 const result=await response.json();expect(result.translations).toEqual({coach:generatedCatalog.coach,learn:'Aprender',spokenSpending:generatedCatalog.spokenSpending});expect(result.untranslatedKeys).toContain('coach');expect(result.untranslatedKeys).toContain('spokenSpending');
});
it('the source catalog itself satisfies protected-copy validation',()=>{expect(()=>checkedTranslations(Object.keys(generatedCatalog),generatedCatalog)).not.toThrow();});
