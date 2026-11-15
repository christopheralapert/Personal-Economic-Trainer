import {createHash} from 'node:crypto';
import {readdirSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const repository=fileURLToPath(new URL('../',import.meta.url));
export const sourceDirectories=Object.freeze(['frontend/web/app','frontend/web/components','frontend/web/i18n','frontend/web/lib','frontend/coach/src','frontend/coach/data','frontend/coach/scripts']);
export const sourceFiles=Object.freeze(['frontend/web/next.config.ts','frontend/web/package.json','frontend/coach/package.json','packages/contracts/api.d.ts','package-lock.json','scripts/web_revision.mjs']);

/** Public artifact compatibility, including uncommitted application changes.
 * Never scans dotenv, Git metadata, user uploads, usage ledgers or build output.
 */
export function webSourceRevision(root=repository){
 const hash=createHash('sha256');
 function file(relative){
  hash.update(relative.replaceAll('\\','/')).update('\0').update(readFileSync(path.join(root,relative),'utf8').replaceAll('\r\n','\n')).update('\0');
 }
 function directory(relative){
  const entries=readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  for(const entry of entries){
   if(entry.name.startsWith('.')||entry.name==='__pycache__')continue;
   const next=path.join(relative,entry.name);
   if(entry.isDirectory())directory(next);
   else if(entry.isFile()&&!/\.test\./u.test(entry.name))file(next);
  }
 }
 for(const relative of sourceDirectories)directory(relative);
 for(const relative of sourceFiles)file(relative);
 return hash.digest('hex');
}
