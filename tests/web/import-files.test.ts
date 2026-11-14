import {test} from "node:test";
import assert from "node:assert/strict";
import {nativeMoney,readManifest} from "../../frontend/web/components/import-files.ts";

test("native money uses currency minor units and exact safe-integer fractions",()=>{
  assert.match(nativeMoney(125,"JPY"),/^125\D/);
  assert.match(nativeMoney(1234,"KWD"),/^1,234\D/);
  assert.equal(nativeMoney(9007199254740991,"EUR").replaceAll(/[\s\u00a0\u202f]/g,""),"90071992547409,91€");
  assert.equal(nativeMoney(9007199254740992,"EUR"),"Amount unavailable");
  assert.equal(nativeMoney(1.25,"EUR"),"Amount unavailable");
  assert.equal(nativeMoney(125,"ZZZ"),"125 ZZZ minor units");
});

test("small native manifests reject authority fields and unsafe file declarations",()=>{
  const manifest={mapping_version:"moneylens.synthetic-csv.v1",source_version:"test",source_customer_ref:"one",currency:"EUR",timezone:"Europe/Helsinki",
    claimed_from:"2026-10-01",claimed_to_exclusive:"2026-11-01",files:[{role:"accounts",size_bytes:10,sha256:"a".repeat(64)},{role:"transactions",size_bytes:20,sha256:"b".repeat(64)}]};
  assert.equal(readManifest(JSON.stringify(manifest)).files.length,2);
  assert.throws(()=>readManifest(JSON.stringify({...manifest,owner_user_id:"forged"})));
  assert.throws(()=>readManifest(JSON.stringify({...manifest,files:[manifest.files[0],manifest.files[0]]})));
  assert.throws(()=>readManifest(JSON.stringify({...manifest,files:[manifest.files[0],{...manifest.files[1],size_bytes:1.5}]})));
});
