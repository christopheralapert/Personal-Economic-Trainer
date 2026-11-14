import {test,before,after} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,mkdir} from "node:fs/promises";
import {createServer,request} from "node:https";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {preparePhoneCertificate,readPhoneCertificate,appleProfile} from "../../scripts/phone-certificate.mjs";
import {phoneOptions,disablePhoneModel,setupHandler} from "../../scripts/preview-phone.mjs";
import {privateHTTPSOrigin,phoneCookieMatches} from "../../scripts/phone-ai-access.mjs";

const scratchRoot=fileURLToPath(new URL("../../../../.cache/phone-checks/",import.meta.url));
let directory,material;
before(async()=>{
  await mkdir(scratchRoot,{recursive:true});directory=await mkdtemp(path.join(scratchRoot,"case-"));
  material=await preparePhoneCertificate({directory,host:"127.0.0.1"});
});
after(async()=>{
  // Verify the absolute deletion target is one named test directory in the intended cache.
  if(directory && path.dirname(path.resolve(directory))===path.resolve(scratchRoot)) await rm(directory,{recursive:true,force:true});
});
function read(port,{pathname="/",host=`127.0.0.1:${port}`,method="GET",trusted=true,servername="localhost"}={}) {
  return new Promise((resolve,reject)=>{
    const req=request({hostname:"127.0.0.1",port,path:pathname,method,headers:{host},ca:trusted ? material.ca : undefined,servername,rejectUnauthorized:true},res=>{
      const parts=[];res.on("data",part=>parts.push(part));res.once("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts)}));
    });req.once("error",reject);req.end();
  });
}
test("private address selection and inherited live flags cannot enable paid phone use",()=>{
  assert(privateHTTPSOrigin("https://192.168.1.101:8443"));
  for(const origin of ["http://192.168.1.101:8443","https://8.8.8.8:8443","https://192.168.1.101.attacker.test:8443","https://192.168.1.101:8443/path"]) assert(!privateHTTPSOrigin(origin));
  assert(!phoneCookieMatches(`__Host-coach-evaluation=${"ä".repeat(64)}`,"a".repeat(64)));
  assert.equal(disablePhoneModel({MONEY_COACH_PHONE_AI_EVALUATION:"true",MONEY_COACH_PHONE_AI_SECRET:"a".repeat(64)}).MONEY_COACH_PHONE_AI_SECRET,"");
  assert.equal(phoneOptions(["--host","192.168.1.101"]).port,3443);
  for(const host of ["0.0.0.0","8.8.8.8","localhost","192.168.1.101.attacker.test","::"]) assert.throws(()=>phoneOptions(["--host",host]));
  assert.throws(()=>phoneOptions(["--host","127.0.0.1","--port","3444"]));
  const env=disablePhoneModel({MONEY_COACH_LOCAL_AI_EVALUATION:"true",MONEYLENS_OPENAI_API_KEY:"fake-test-key",OPENAI_API_KEY:"fake-test-key",MONEYLENS_MODEL_BILLING_POLICY:"paid",MONEY_COACH_EVALUATION_DIRECTORY:"fake-local-path"});
  assert.equal(env.MONEY_COACH_LOCAL_AI_EVALUATION,"false");assert.equal(env.MONEYLENS_MODEL_BILLING_POLICY,"free_only");
  assert.equal(env.MONEYLENS_OPENAI_API_KEY,"");assert.equal(env.OPENAI_API_KEY,"");assert.equal(env.MONEY_COACH_EVALUATION_DIRECTORY,"");
});
test("the seven-day local chain is reused, identity checked and never silently replaced",async()=>{
  const again=await preparePhoneCertificate({directory,host:"127.0.0.1"});assert.equal(again.fingerprint,material.fingerprint);
  assert(Date.parse(material.expiresAt)<=Date.now()+7*86400000);
  await assert.rejects(readPhoneCertificate(directory,"192.168.99.99"));
  const profile=appleProfile(material.certificate,material.fingerprint);
  assert(profile.includes(`<data>${material.certificate.toString("base64")}</data>`));
  assert(profile.includes("com.apple.security.root"));assert(!profile.includes("BEGIN PRIVATE KEY"));assert(!profile.includes("com.apple.mdm"));
  const original=await readFile(path.join(directory,"server.key"));
  await writeFile(path.join(directory,"server.key"),await readFile(path.join(directory,"ca.key")));
  await assert.rejects(preparePhoneCertificate({directory,host:"127.0.0.1"}));
  await writeFile(path.join(directory,"server.key"),original);
});
test("real TLS requires explicit CA trust and bootstrap exposes only the exact public certificate payloads",async()=>{
  const server=createServer({key:material.key,cert:material.cert,minVersion:"TLSv1.2"});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;
  server.on("request",setupHandler({host:"127.0.0.1",setupPort:port,origin:"https://127.0.0.1:3443",material}));
  try {
    await assert.rejects(read(port,{trusted:false}));await assert.rejects(read(port,{servername:"different.invalid"}));
    const cert=await read(port,{pathname:"/money-coach-ca.cer"});assert.equal(cert.status,200);assert(cert.body.equals(material.certificate));assert.equal(cert.headers["cache-control"],"no-store");
    assert.equal((await read(port,{pathname:"/money-coach.mobileconfig"})).status,200);
    for(const pathname of ["/ca.key","/server.key","/.env","/api/chat","/money-coach-ca.cer?file=ca.key","/../ca.key"]) assert.equal((await read(port,{pathname})).status,404);
    assert.equal((await read(port,{host:"other.invalid"})).status,403);assert.equal((await read(port,{method:"POST"})).status,405);
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
