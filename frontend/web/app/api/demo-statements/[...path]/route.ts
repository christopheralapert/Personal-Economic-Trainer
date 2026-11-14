import {NextRequest,NextResponse} from 'next/server';
import {proxyPrivate,privateHeaders} from '../../private-proxy';
export const dynamic='force-dynamic';
const allowed=new Set(['GET:sample/auto-taxis.csv','POST:session','GET:statements/wise/accounts','POST:statements/wise/preview','POST:statements/wise/confirm','GET:dataset']);
async function proxy(request:NextRequest,context:{params:Promise<{path:string[]}>}){
 const endpoint=(await context.params).path.join('/');
 if(!allowed.has(`${request.method}:${endpoint}`))return NextResponse.json({error:{code:'NOT_FOUND'}},{status:404,headers:privateHeaders()});
 const result=await proxyPrivate(request,`/v1/demo-statements/${endpoint}`,8192);
 if(endpoint==='sample/auto-taxis.csv'&&result.ok)result.headers.set('Content-Disposition','attachment; filename="auto-taxis.csv"');
 return result;
}
export const GET=proxy;
export const POST=proxy;
