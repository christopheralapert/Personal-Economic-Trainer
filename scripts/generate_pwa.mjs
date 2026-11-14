// Render repository-authored geometric SVG assets and stamp a reproducible worker version.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";

const root = fileURLToPath(new URL("../", import.meta.url));
const web = path.join(root, "frontend/web");
const icons = path.join(web, "public/icons");
const svg = await readFile(path.join(icons, "icon.svg"));
await Promise.all([192, 512].map(size => sharp(svg).resize(size, size).png().toFile(path.join(icons, `icon-${size}.png`))));
const maskable = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" fill="#00814a"/><path d="M156 330V182h32l68 84 68-84h32v148h-40v-86l-60 73-60-73v86Z" fill="#fff"/></svg>');
await sharp(maskable).resize(512, 512).png().toFile(path.join(icons, "maskable-512.png"));
await sharp(svg).resize(180, 180).png().toFile(path.join(icons, "apple-touch-icon.png"));

const hash = createHash("sha256");
async function digest(directory) {
  for (const entry of (await readdir(directory, {withFileTypes: true})).sort((a,b) => a.name.localeCompare(b.name))) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await digest(target);
    else { hash.update(path.relative(web, target).split(path.sep).join("/")); hash.update((await readFile(target,"utf8")).replace(/\r\n/g,"\n")); }
  }
}
await digest(path.join(web, "app"));
await digest(path.join(web, "components"));
await digest(path.join(web, "lib"));
await digest(path.join(web, "i18n"));
// Include shared Coach components in the public worker's build identity.
await digest(path.join(root,"frontend/coach/src"));
hash.update((await readFile(path.join(web, "next.config.ts"),"utf8")).replace(/\r\n/g,"\n"));
hash.update((await readFile(path.join(root, "package-lock.json"),"utf8")).replace(/\r\n/g,"\n"));
hash.update(svg);
hash.update((await readFile(fileURLToPath(import.meta.url),"utf8")).replace(/\r\n/g,"\n"));
const workerPath = path.join(web, "public/sw.js");
const worker = await readFile(workerPath, "utf8");
hash.update(worker.replace(/const BUILD = "[^"]+";/, 'const BUILD = "BUILD_TOKEN";').replace(/\r\n/g,"\n"));
const build = `moneylens-public-${hash.digest("hex").slice(0,16)}`;
await writeFile(workerPath, worker.replace(/const BUILD = "[^"]+";/, `const BUILD = "${build}";`));
console.log(`Rendered install icons and versioned public worker: ${build}`);
