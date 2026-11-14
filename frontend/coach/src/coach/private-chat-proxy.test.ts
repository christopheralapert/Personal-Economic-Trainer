import {describe,it,expect,vi,afterEach} from 'vitest';
import {NextRequest} from 'next/server';
import {POST} from '../../../web/app/api/v1/[...path]/route';
import {proxyPrivate} from '../../../web/app/api/private-proxy';
vi.mock('../../../web/app/api/private-proxy',()=>({privateHeaders:()=>new Headers(),proxyPrivate:vi.fn(async()=>new Response(null,{status:204}))}));
afterEach(()=>vi.clearAllMocks());
describe('private conversational ingress budget',()=>{
 it('allows bounded dialogue without widening unrelated endpoint limits',async()=>{
  for(const [path,limit] of [[['coach','query'],65536],[['analysis','tools','execute'],8192]] as const){
   const request=new NextRequest('http://localhost/api/v1/'+path.join('/'),{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
   expect((await POST(request,{params:Promise.resolve({path:[...path]})})).status).toBe(204);
   expect(proxyPrivate).toHaveBeenLastCalledWith(request,'/v1/'+path.join('/'),limit);
  }
 });
});
