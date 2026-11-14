import assert from "node:assert/strict";
import test from "node:test";
import {createHmac} from "node:crypto";
import {psuContext} from "../../frontend/web/app/api/psu-context.ts";

test("ngrok's last verified hop replaces forged browser PSU headers",()=>{
  const before={...process.env};
  try{
    process.env.MONEYLENS_PSU_PROXY_SECRET="offline-test-proxy-secret-with-32-characters";
    process.env.MONEYLENS_PSU_INGRESS="ngrok";
    process.env.MONEYLENS_APP_ORIGIN="https://fixture.ngrok-free.dev";
    const headers=new Headers({host:"fixture.ngrok-free.dev","x-forwarded-for":"198.51.100.99, 192.0.2.10",
      "x-forwarded-proto":"http, https","user-agent":"Fixture browser","x-moneylens-session-id":"fixture-session",
      "psu-ip-address":"forged","x-moneylens-psu-context":"forged"});
    const result=psuContext(headers,"/v1/live-banking/connections/test/refresh","POST")!;
    assert.equal(JSON.parse(result.raw).headers["Psu-Ip-Address"],"192.0.2.10");
    assert.equal(JSON.parse(result.raw).headers["Psu-User-Agent"],"Fixture browser");
    assert.equal(result.signature,createHmac("sha256",process.env.MONEYLENS_PSU_PROXY_SECRET).update(result.raw).digest("hex"));
    headers.set("x-forwarded-proto","https, http");assert.equal(psuContext(headers,"/path","POST"),null);
    headers.set("x-forwarded-proto","https");headers.set("host","other.example");assert.equal(psuContext(headers,"/path","POST"),null);
    delete process.env.MONEYLENS_PSU_INGRESS;assert.equal(psuContext(headers,"/path","POST"),null);
  }finally{for(const key of Object.keys(process.env))if(!(key in before))delete process.env[key];Object.assign(process.env,before);}
});
