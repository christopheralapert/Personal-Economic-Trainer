import {afterEach,it,expect,vi} from 'vitest';
import {loadGeneratedLanguage} from './generated-client';
import {generatedCatalog} from './generated-catalog';
import {COACH_REVISION,REVISION_HEADER} from '@/coach/transport';
afterEach(()=>vi.unstubAllGlobals());
it('regenerates every batch on repeated language selections without reading or writing browser output storage',async()=>{
 const storage={getItem:vi.fn(()=>{throw Error('must not load cached copy');}),setItem:vi.fn()};vi.stubGlobal('localStorage',storage);
 const network=vi.fn<typeof fetch>(async(_url,init)=>{const {keys}=JSON.parse(String(init?.body));return Response.json({translations:Object.fromEntries(keys.map((key:string)=>[key,'Fresh '+generatedCatalog[key]]))},{headers:{[REVISION_HEADER]:COACH_REVISION}});});vi.stubGlobal('fetch',network);
 const batches=Math.ceil(Object.keys(generatedCatalog).length/32);
 for(let index=0;index<2;index++)await loadGeneratedLanguage('es',new AbortController().signal,()=>{});
 expect(network).toHaveBeenCalledTimes(batches*2);expect(storage.getItem).not.toHaveBeenCalled();expect(storage.setItem).not.toHaveBeenCalled();expect(network.mock.calls.every(([,init])=>init?.cache==='no-store')).toBe(true);
});
