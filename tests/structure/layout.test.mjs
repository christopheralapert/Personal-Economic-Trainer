import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import path from "node:path";

const root=fileURLToPath(new URL("../../",import.meta.url));
const read=relative=>readFile(path.join(root,relative),"utf8");
const json=async relative=>JSON.parse(await read(relative));

test("frontend workspaces and lockfile point at existing applications",async()=>{
  const manifest=await json("package.json"),lock=await json("package-lock.json");
  assert.deepEqual(manifest.workspaces,["frontend/web","frontend/coach"]);
  assert.deepEqual(lock.packages[""].workspaces,manifest.workspaces);
  for(const workspace of manifest.workspaces) {
    const app=await json(`${workspace}/package.json`);
    assert.equal(lock.packages[workspace].name,app.name);
    assert.equal(lock.packages[`node_modules/${app.name}`].resolved,workspace);
  }
});

test("web aliases resolve shared coach source and API contracts",async()=>{
  const config=await json("frontend/web/tsconfig.json");
  for(const alias of ["@/*","@contracts","@web/*"]) {
    for(const target of config.compilerOptions.paths[alias]) {
      const resolved=path.resolve(root,"frontend/web",target.replace(/\*$/, ""));
      const info=await stat(resolved);
      assert.ok(alias==="@contracts" ? info.isFile() : info.isDirectory(),alias);
    }
  }
  const postcss=await import("../../frontend/web/postcss.config.mjs");
  assert.ok(postcss.default.plugins["@tailwindcss/postcss"]);
});

test("backend migration and fixture paths retain repository-root boundaries",async()=>{
  const ini=await read("alembic.ini");
  for(const [setting,relative] of [["script_location","backend/db/migrations"],["prepend_sys_path","backend/api"]]) {
    assert.ok(ini.includes(`${setting} = %(here)s/${relative}`));
    assert.ok((await stat(path.join(root,relative))).isDirectory());
  }
  for(const relative of ["backend/workers/run.py","backend/api/requirements.txt","backend/db/migrations/sql/0001_owned_core.sql","fixtures/synthetic/demo.v1.json","frontend/prototype/index.html"]) {
    assert.ok((await stat(path.join(root,relative))).isFile(),relative);
  }
  const config=await read("backend/api/pyproject.toml");
  assert.ok(config.includes('testpaths = ["../../tests/api"]'));
});
