import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";
import sharp from "sharp";
import {coachRevision} from "./revision.mjs";

const root=fileURLToPath(new URL("../",import.meta.url));
const icon=await readFile(path.join(root,"public/icon.svg"));
for(const [name,size] of [["icon-192.png",192],["icon-512.png",512],["apple-touch-icon.png",180]]) {
  await sharp(icon).resize(size,size).png().toFile(path.join(root,"public",name));
}
// Keep the existing app mark inside the central safe zone of a full-bleed icon.
const inset=await sharp(icon).resize(320,320).png().toBuffer();
await sharp({create:{width:512,height:512,channels:4,background:"#00814a"}})
  .composite([{input:inset,gravity:"centre"}]).png().toFile(path.join(root,"public/icon-maskable.png"));
const version=coachRevision().slice(0,20);
const template=await readFile(path.join(root,"scripts/worker.js"),"utf8");
await writeFile(path.join(root,"public/sw.js"),template.replace("__BUILD__",version));
console.log(`Money Coach public PWA assets: ${version}`);
