import {createHash} from "node:crypto";
import {readdirSync,readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=fileURLToPath(new URL("../",import.meta.url));
/** Build-time public compatibility identity; never reads dotenv or customer state. */
export function coachRevision() {
  const hash=createHash("sha256");
  function file(relative) {
    hash.update(relative.replaceAll("\\","/")).update("\0")
      .update(readFileSync(path.join(root,relative),"utf8").replaceAll("\r\n","\n")).update("\0");
  }
  function directory(relative) {
    const entries=readdirSync(path.join(root,relative),{withFileTypes:true}).sort((a,b)=>a.name<b.name ? -1 : a.name>b.name ? 1 : 0);
    for(const entry of entries) {
      const next=path.join(relative,entry.name);
      if(entry.isDirectory()) directory(next);
      else if(!/\.test\./.test(next)) file(next);
    }
  }
  for(const dir of ["src","data","scripts"]) directory(dir);
  for(const name of ["next.config.ts","package.json","../../package-lock.json","public/icon.svg"]) file(name);
  return hash.digest("hex");
}
