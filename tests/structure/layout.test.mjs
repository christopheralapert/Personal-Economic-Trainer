import {test} from "node:test";
import assert from "node:assert/strict";
import {readFile,stat} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
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
  const configPath="backend/db/alembic.ini";
  const ini=await read(configPath);
  for(const [setting,relative] of [["script_location","backend/db/migrations"],["prepend_sys_path","backend/api"]]) {
    const value=ini.split(/\r?\n/).find(line=>line.startsWith(`${setting} = `))?.split(" = ")[1];
    assert.ok(value,setting);
    const resolved=path.resolve(value.replace("%(here)s",path.dirname(path.join(root,configPath))));
    assert.equal(resolved,path.join(root,relative));
    assert.ok((await stat(resolved)).isDirectory());
  }
  for(const relative of ["backend/workers/run.py","backend/api/requirements.txt","backend/db/migrations/sql/0001_owned_core.sql","fixtures/synthetic/demo.v1.json","frontend/prototype/index.html"]) {
    assert.ok((await stat(path.join(root,relative))).isFile(),relative);
  }
  const config=await read("backend/api/pyproject.toml");
  assert.ok(config.includes('testpaths = ["../../tests/api"]'));
});

for(const suite of ["", ".container", ".finance", ".first-login", ".legal"]) {
  test(`browser ${suite.slice(1)||"default"} configuration discovers tests from outside the repository`,()=>{
    const config=path.join(root,`tests/config/playwright${suite}.config.ts`);
    const result=spawnSync(process.execPath,[path.join(root,"node_modules/@playwright/test/cli.js"),"test","--config",config,"--list","--reporter=json"],{
      cwd:tmpdir(),encoding:"utf8",windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,
      // Listing only: no server or database is started and no test is executed.
      env:{...process.env,MONEYLENS_BROWSER_FINANCE:"true"},
    });
    assert.ifError(result.error);
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.equal(report.errors.length,0);
    assert.ok(report.suites.length>0,"Expected browser tests to be discovered");
    const directory=path.join(root,suite===".finance" ? "tests/finance-browser" : "tests/browser");
    assert.equal(path.resolve(report.config.rootDir),directory);
    for(const project of report.config.projects) {
      assert.equal(path.resolve(project.testDir),directory);
      const relative=path.relative(path.join(root,"test-results"),project.outputDir);
      assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    }
  });
}
