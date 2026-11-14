import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {MANIFEST,safeRelative,inventory,verifyRelease,runtimeEnvironment} from "../../scripts/release-lib.mjs";
import {releaseOptions} from "../../scripts/run-demo.mjs";

test("release paths reject private files, traversal and Windows alternate streams",()=>{
 for(const value of ["../outside","a/../../secret","/root","a\\b","a:b","nested/.env.local","AGENTS.md","nested/agent.md","ca.pem","x/.git/config"]) assert.throws(()=>safeRelative(value));
 assert.equal(safeRelative("apps/money-coach/.next/BUILD_ID"),"apps/money-coach/.next/BUILD_ID");
});
test("launcher removes credentials, evaluation permission and Node preloads",()=>{
 const result=runtimeEnvironment({PATH:"tools",SystemRoot:"system",OPENAI_API_KEY:"fixture-not-a-key",MONEYLENS_OPENAI_API_KEY:"fixture",NODE_OPTIONS:"--require evil",NODE_PATH:"outside",MONEY_COACH_LOCAL_AI_EVALUATION:"true"},{host:"127.0.0.1",port:3001});
 assert.deepEqual(result,{PATH:"tools",SystemRoot:"system",NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",HOSTNAME:"127.0.0.1",PORT:"3001",MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEYLENS_MODEL_BILLING_POLICY:"free_only"});
 assert.deepEqual(releaseOptions([]),{host:"127.0.0.1",port:3001});
 for(const args of [["--port","0"],["--port","65536"],["--host","example.com"],["--model","anything"]]) assert.throws(()=>releaseOptions(args));
});
async function fixture() {
 const root=await mkdtemp(path.join(tmpdir(),"money-coach-release-unit-"));
 for(const name of ["run-demo.mjs","release-lib.mjs","apps/money-coach/server.js","apps/money-coach/.next/BUILD_ID","apps/money-coach/public/sw.js"]) {await mkdir(path.dirname(path.join(root,name)),{recursive:true});await writeFile(path.join(root,name),"fixture");}
 const manifest={format:"money-coach-demo.v1",revision:"a".repeat(64),platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split(".")[0]),model:"disabled",...await inventory(root)};
 await writeFile(path.join(root,MANIFEST),JSON.stringify(manifest));return {root,manifest};
}
test("verified inventory refuses changed content and unexpected private files",async()=>{
 const {root}=await fixture();await verifyRelease(root);
 await writeFile(path.join(root,"run-demo.mjs"),"changed");await assert.rejects(verifyRelease(root),/mismatch/);
 await writeFile(path.join(root,".env"),"fixture");await assert.rejects(verifyRelease(root),/Private/);
});
test("manifest rejects incompatible runtime and malicious inventory paths",async()=>{
 const {root,manifest}=await fixture();
 await writeFile(path.join(root,MANIFEST),JSON.stringify({...manifest,nodeMajor:0}));await assert.rejects(verifyRelease(root),/runtime/);
 await writeFile(path.join(root,MANIFEST),JSON.stringify({...manifest,files:[{path:"../../outside",bytes:0,sha256:"a".repeat(64)}]}));await assert.rejects(verifyRelease(root),/path/);
});

test("traced links cannot escape the build tree or introduce a cycle",async(t)=>{
 const {symlink}=await import("node:fs/promises");
 const {copyTracedTree}=await import("../../scripts/release-lib.mjs");
 const root=await mkdtemp(path.join(tmpdir(),"money-coach-release-links-")),source=path.join(root,"source"),outside=path.join(root,"outside");
 await mkdir(source);await mkdir(outside);await writeFile(path.join(outside,"canary"),"must-not-copy");
 try {await symlink(outside,path.join(source,"escape"),process.platform==="win32" ? "junction" : "dir");}
 catch(error) {if(["EPERM","EACCES"].includes(error.code)) {t.skip("OS did not permit creating the test link");return;}throw error;}
 await assert.rejects(copyTracedTree(source,path.join(root,"destination")),/External or cyclic/);
 const cyclic=path.join(root,"cyclic");await mkdir(cyclic);await symlink(cyclic,path.join(cyclic,"again"),process.platform==="win32" ? "junction" : "dir");
 await assert.rejects(copyTracedTree(cyclic,path.join(root,"cycle-destination")),/External or cyclic/);
});
