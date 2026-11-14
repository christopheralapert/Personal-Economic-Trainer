import 'server-only';
import {loadDataset} from '@/engine/datasets';
import {loadTransactions} from '@/engine';
/** Session data is fetched server-to-server with the current browser cookie only. */
export async function readPublicDataset(request:Request,key:string){
 if(key!=='session')return loadDataset(key);
 const cookie=(request.headers.get('cookie')??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('moneycoach_demo_import='));
 if(!cookie)throw Error('Demo session required');
 const base=process.env.MONEYLENS_API_URL??'http://127.0.0.1:8000';
 const response=await fetch(base+'/v1/demo-statements/dataset',{headers:{cookie},cache:'no-store',signal:AbortSignal.any([request.signal,AbortSignal.timeout(5000)])});
 if(!response.ok)throw Error('Demo session unavailable');return loadTransactions(await response.json());
}
