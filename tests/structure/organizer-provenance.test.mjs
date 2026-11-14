import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
const read=relative=>readFileSync(new URL(relative,import.meta.url),"utf8");
test("anonymous organizer1 maps to the documented whole-customer source and exact taxi cents",()=>{
 const manifest=JSON.parse(read("../../frontend/coach/data/organizer-source.json"));
 const profile=JSON.parse(read("../../frontend/coach/data/organizer-1.v1.json")).profiles[0];
 const source=manifest.profiles.find(profile=>profile.key==="organizer1");
 assert.equal(manifest.source,"https://github.com/hackjunction/Junction-2026-S-pankki");
 assert.equal(manifest.sha256,"49b3265d8e44e751de305a074dcffcda732bb79aa1e07b46fcca774ce76f1e63");
 assert.equal(manifest.bytes,362796501);assert.equal(manifest.source_rows,3626755);
 assert(read("../../scripts/import_junction_demo.py").includes("if digest.hexdigest()!=SOURCE_SHA:raise ValueError('Source hash mismatch')"));
 assert.match(read("../../frontend/coach/src/engine/datasets.ts"),/organizer1:\(\)=>import\("\.\.\/\.\.\/data\/organizer-1\.v1\.json"\)/);
 assert.equal(profile.mode,"synthetic");assert.equal(profile.transactions.length,source.rows);assert.equal(source.rows,1543);
 assert.equal(new Set(profile.transactions.map(row=>row.id)).size,source.rows);
 const taxis=profile.transactions.filter(row=>row.category==="taxi"&&row.booked_on>="2026-08-01"&&row.booked_on<"2026-09-01");
 assert.equal(taxis.length,1);assert.equal(taxis[0].amount_minor,-3097);assert.equal(taxis[0].booked_on,"2026-08-26");
});
