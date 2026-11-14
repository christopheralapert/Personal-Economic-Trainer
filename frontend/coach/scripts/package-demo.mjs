import {mkdtemp,readFile,writeFile,realpath,mkdir} from "node:fs/promises";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
import {coachRevision} from "./revision.mjs";
import {MANIFEST,copyTracedTree,inventory,verifyRelease,contained} from "./release-lib.mjs";

const app=fileURLToPath(new URL("../",import.meta.url));
export async function packageDemo() {
  const revision=coachRevision(),build=path.join(app,".next");
  const required=JSON.parse(await readFile(path.join(build,"required-server-files.json"),"utf8"));
  if(required.config?.env?.NEXT_PUBLIC_MONEY_COACH_REVISION!==revision || required.config.output!=="standalone") throw new Error("Build is missing or stale; run build:coach first");
  const worker=await readFile(path.join(app,"public/sw.js"),"utf8");
  if(!worker.includes(revision.slice(0,20))) throw new Error("PWA shell is stale; run build:coach first");
  const standalone=await realpath(path.join(build,"standalone"));
  const parent=path.resolve(app,"../../.cache/money-coach-release");
  await mkdir(parent,{recursive:true});
  const destination=await mkdtemp(path.join(parent,`demo-${revision.slice(0,12)}-`));
  if(!contained(parent,destination)) throw new Error("Invalid release destination");
  await copyTracedTree(standalone,destination);
  const target=path.join(destination,"frontend/coach");
  await copyTracedTree(await realpath(path.join(build,"static")),path.join(target,".next/static"));
  await copyTracedTree(await realpath(path.join(app,"public")),path.join(target,"public"));
  for(const name of ["run-demo.mjs","release-lib.mjs"]) await copyTracedTree(path.join(app,"scripts",name),path.join(destination,name),path.join(app,"scripts"));
  const collected=await inventory(destination);
  const manifest={format:"money-coach-demo.v1",revision,platform:process.platform,arch:process.arch,nodeMajor:Number(process.versions.node.split(".")[0]),model:"disabled",...collected};
  await writeFile(path.join(destination,MANIFEST),JSON.stringify(manifest,null,2)+"\n",{flag:"wx"});
  await verifyRelease(destination);
  const archive=destination+".tar.gz",tar=spawnSync("tar",["-czf",archive,"-C",destination,"."],{stdio:"pipe",windowsHide:true});
  if(tar.error || tar.status!==0) throw new Error("Folder verified, but tar archive failed; keep the folder and check tar availability");
  process.stdout.write(JSON.stringify({directory:destination,archive,revision,files:collected.files.length,bytes:collected.bytes,platform:manifest.platform,arch:manifest.arch,nodeMajor:manifest.nodeMajor,model:"disabled"},null,2)+"\n");
  return {directory:destination,archive,manifest};
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) packageDemo().catch(error=>{process.stderr.write(`Demo packaging failed: ${error.message}\n`);process.exitCode=1;});
