import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourceDirectories,sourceFiles,webSourceRevision} from '../../scripts/web_revision.mjs';

async function fixture(run){
 const root=await mkdtemp(path.join(os.tmpdir(),'money-coach-source-'));
 try{
  for(const dir of sourceDirectories)await mkdir(path.join(root,dir),{recursive:true});
  for(const file of sourceFiles){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),'synthetic source\n');}
  await run(root);
 }finally{await rm(root,{recursive:true,force:true});}
}
test('source identity is stable and changes when an uncommitted application file changes',()=>fixture(async root=>{
 const original=webSourceRevision(root);assert.match(original,/^[a-f0-9]{64}$/u);assert.equal(original,webSourceRevision(root));
 await writeFile(path.join(root,'frontend/coach/src/planning.ts'),'new implementation');
 assert.notEqual(original,webSourceRevision(root));
}));
test('source identity normalizes checkout line endings',()=>fixture(async root=>{
 const file=path.join(root,'frontend/web/app/page.tsx');await writeFile(file,'one\r\ntwo\r\n');const original=webSourceRevision(root);
 await writeFile(file,'one\ntwo\n');assert.equal(original,webSourceRevision(root));
}));
test('secrets, test fixtures and generated state do not enter the public source identity',()=>fixture(async root=>{
 const original=webSourceRevision(root);
 for(const relative of ['.env','.cache/usage.json','test-results/run.json','README.md','frontend/coach/src/example.test.ts']){
  await mkdir(path.dirname(path.join(root,relative)),{recursive:true});await writeFile(path.join(root,relative),'synthetic private/test value');
 }
 assert.equal(original,webSourceRevision(root));
}));
test('container build includes the source identity helper required by Next configuration',async()=>{
 const dockerfile=await readFile(new URL('../../deploy/web.Dockerfile',import.meta.url),'utf8');
 assert.match(dockerfile,/COPY scripts\/web_revision\.mjs scripts\/web_revision\.mjs/u);
 const context=await readFile(new URL('../../.dockerignore',import.meta.url),'utf8');
 assert.match(context,/^!scripts\/web_revision\.mjs\r?$/mu);
});
