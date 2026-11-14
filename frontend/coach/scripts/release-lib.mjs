import {createHash} from "node:crypto";
import {lstat,readdir,readFile,realpath,stat,mkdir,copyFile} from "node:fs/promises";
import path from "node:path";

export const MANIFEST="demo-release.json";
export const MAX_FILES=50000,MAX_BYTES=512*1024*1024;
export function contained(root,target) {const relative=path.relative(root,target);return relative==="" || (!relative.startsWith(".."+path.sep) && relative!==".." && !path.isAbsolute(relative));}
export function safeRelative(name) {
  if(typeof name!=="string" || !name || name.includes("\\") || name.includes(":") || name.includes("\0") || path.posix.isAbsolute(name)) throw new Error("Unsafe release path");
  const parts=name.split("/");
  if(parts.some(part=>!part || part==="." || part===".." || /^(?:\.env(?:\..*)?|agents?\.md|\.git|\.cache|\.codex|\.agents)$/i.test(part) || /\.(?:pem|key|p12|pfx|cer|mobileconfig)$/i.test(part))) throw new Error("Private or unsafe release path");
  return name;
}
/** Flatten only links into the traced tree; external links/junctions never copy workspace data. */
export async function copyTracedTree(source,destination,root=source,ancestors=new Set(),budget={files:0,bytes:0}) {
  const resolved=await realpath(source);
  if(!contained(root,resolved) || ancestors.has(resolved)) throw new Error("External or cyclic traced link");
  const info=await stat(resolved);
  if(info.isDirectory()) {
    await mkdir(destination,{recursive:true});const next=new Set(ancestors);next.add(resolved);
    for(const name of (await readdir(resolved)).sort()) {safeRelative(name);await copyTracedTree(path.join(resolved,name),path.join(destination,name),root,next,budget);}
  } else if(info.isFile()) {budget.files++;budget.bytes+=info.size;if(budget.files>MAX_FILES || budget.bytes>MAX_BYTES) throw new Error("Release budget exceeded");await mkdir(path.dirname(destination),{recursive:true});await copyFile(resolved,destination);}
  else throw new Error("Unsupported release entry");
}
export async function inventory(root) {
  const files=[];let bytes=0;
  async function walk(directory) {
    for(const name of (await readdir(directory)).sort()) {
      const target=path.join(directory,name),relative=path.relative(root,target).split(path.sep).join("/");safeRelative(relative);
      const info=await lstat(target);
      if(info.isSymbolicLink()) throw new Error("Release links are not permitted");
      if(info.isDirectory()) await walk(target);
      else if(info.isFile()) {
        if(relative===MANIFEST) continue;
        bytes+=info.size;if(bytes>MAX_BYTES || files.length>=MAX_FILES) throw new Error("Release budget exceeded");
        files.push({path:relative,bytes:info.size,sha256:createHash("sha256").update(await readFile(target)).digest("hex")});
      } else throw new Error("Unsupported release entry");
    }
  }
  await walk(root);return {files,bytes};
}
export async function verifyRelease(root) {
  const entry=path.join(root,MANIFEST),info=await lstat(entry);
  if(!info.isFile() || info.isSymbolicLink() || info.size>8*1024*1024) throw new Error("Invalid release manifest");
  const manifest=JSON.parse(await readFile(entry,"utf8"));
  if(manifest.format!=="money-coach-demo.v1" || !/^[a-f0-9]{64}$/.test(manifest.revision) || manifest.model!=="disabled" || manifest.platform!==process.platform || manifest.arch!==process.arch || manifest.nodeMajor!==Number(process.versions.node.split(".")[0]) || !Array.isArray(manifest.files) || manifest.files.length>MAX_FILES) throw new Error("Release format or runtime mismatch");
  const expected=new Map();let bytes=0;
  for(const file of manifest.files) {
    safeRelative(file.path);
    if(file.path===MANIFEST || expected.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes<0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error("Invalid release inventory");
    bytes+=file.bytes;if(bytes>MAX_BYTES) throw new Error("Release budget exceeded");expected.set(file.path,file);
  }
  const actual=await inventory(root);
  if(actual.files.length!==expected.size || actual.bytes!==manifest.bytes || bytes!==manifest.bytes) throw new Error("Release inventory mismatch");
  for(const file of actual.files) {const known=expected.get(file.path);if(!known || known.bytes!==file.bytes || known.sha256!==file.sha256) throw new Error("Release content mismatch");}
  for(const required of ["run-demo.mjs","release-lib.mjs","frontend/coach/server.js","frontend/coach/.next/BUILD_ID","frontend/coach/public/sw.js"]) if(!expected.has(required)) throw new Error("Incomplete release");
  return manifest;
}
/** Only basic OS process settings pass through; credentials, evaluator flags and preloads do not. */
export function runtimeEnvironment(parent,{host,port}) {
  const allowed=new Set(["path","systemroot","windir","comspec","temp","tmp","home","userprofile","lang","lc_all"]);
  return {...Object.fromEntries(Object.entries(parent).filter(([key])=>allowed.has(key.toLowerCase()))),
    NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",HOSTNAME:host,PORT:String(port),
    MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEYLENS_MODEL_BILLING_POLICY:"free_only"};
}
