import {readdir,readFile} from "node:fs/promises";
import path from "node:path";
const failures=[];
async function check(dir) {
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const name=path.join(dir,entry.name);if(entry.isDirectory()) {await check(name);continue;}
    if(!/\.[jt]sx?$/.test(name)) continue;
    const source=await readFile(name,"utf8");
    if(/\b\d+(?:\.\d+)?px\b/.test(source) || /(?:[\w-]+-)?(?:w|h|min-w|min-h|max-w|max-h|size|p|px|py|m|mx|my|rounded|text|ring|basis|gap|top|bottom|left|right|grid-cols|grid-rows|transition)-\[[^\]]+\]/.test(source)) failures.push(name);
  }
}
for(const directory of process.argv.slice(2).length ? process.argv.slice(2) : ["src/components","src/app"]) await check(directory);
if(failures.length) {console.error("Use Tailwind scale or theme tokens; raw px/arbitrary values found:",failures);process.exitCode=1;}
else console.log("Component/app values use the Tailwind scale and named theme tokens.");
