import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {access,mkdir,readFile,writeFile,open,unlink} from "node:fs/promises";
import {X509Certificate,createPrivateKey,randomBytes} from "node:crypto";
import {isIPv4} from "node:net";
import {fileURLToPath} from "node:url";
import path from "node:path";

const run=promisify(execFile);
export const certificateRoot=fileURLToPath(new URL("../../../.cache/money-coach-phone/",import.meta.url));
export function privateAddress(host) {
  if(!isIPv4(host)) return false;
  const [a,b]=host.split(".").map(Number);
  return host==="127.0.0.1" || a===10 || (a===172 && b>=16 && b<=31) || (a===192 && b===168);
}
export async function findOpenSSL() {
  for(const command of [process.env.MONEY_COACH_OPENSSL,"openssl","C:/Program Files/Git/usr/bin/openssl.exe"].filter(Boolean)) {
    try {await run(command,["version"],{windowsHide:true,timeout:5000});return command;} catch { /* Try the next installed executable. */ }
  }
  throw new Error("OpenSSL is required; use Git for Windows or set MONEY_COACH_OPENSSL to its executable. No certificate store is changed.");
}
export async function readPhoneCertificate(directory,host) {
  const [ca,key,cert]=await Promise.all(["ca.pem","server.key","server.pem"].map(name=>readFile(path.join(directory,name))));
  const authority=new X509Certificate(ca),leaf=new X509Certificate(cert);
  const now=Date.now(),expires=Math.min(Date.parse(authority.validTo),Date.parse(leaf.validTo));
  if(!authority.ca || leaf.ca || !authority.verify(authority.publicKey) || !leaf.verify(authority.publicKey) || !leaf.checkIP(host) || !leaf.checkPrivateKey(createPrivateKey(key)) || now<Date.parse(leaf.validFrom) || now<Date.parse(authority.validFrom) || expires<=now) {
    throw new Error("The local phone certificate is expired, incomplete or does not match this address. Existing keys were not replaced.");
  }
  return {ca,key,cert,certificate:authority.raw,fingerprint:authority.fingerprint256,expiresAt:new Date(expires).toISOString()};
}
export async function preparePhoneCertificate({directory,host,openssl}) {
  if(!privateAddress(host)) throw new Error("Choose one explicit private IPv4 address; public addresses, DNS names and wildcard binds are not allowed.");
  await mkdir(directory,{recursive:true,mode:0o700});
  // Never silently regenerate an already trusted CA, including after an interrupted setup.
  const existing=await Promise.all(["ca.pem","ca.key","server.pem","server.key"].map(async name=>{try {await access(path.join(directory,name));return true;} catch {return false;}}));
  if(existing.some(Boolean)) return readPhoneCertificate(directory,host);
  const lock=await open(path.join(directory,"prepare.lock"),"wx",0o600);
  try {
    const command=openssl ?? await findOpenSSL();
    const execute=async args=>{
      try {await run(command,args,{cwd:directory,windowsHide:true,timeout:30000,maxBuffer:65536});}
      catch {throw new Error("Local certificate generation failed. No certificate was installed and existing setup files were retained.");}
    };
    await execute(["req","-x509","-newkey","rsa:3072","-sha256","-noenc","-keyout","ca.key","-out","ca.pem","-days","7","-subj","/CN=Money Coach local test CA/O=Local development","-addext","basicConstraints=critical,CA:TRUE,pathlen:0","-addext","keyUsage=critical,keyCertSign,cRLSign"]);
    await execute(["req","-new","-newkey","rsa:2048","-noenc","-keyout","server.key","-out","server.csr","-subj","/CN=Money Coach Wi-Fi preview"]);
    await writeFile(path.join(directory,"server.ext"),`basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:${host},IP:127.0.0.1,DNS:localhost\n`,{mode:0o600});
    await execute(["x509","-req","-in","server.csr","-CA","ca.pem","-CAkey","ca.key","-set_serial",`0x${randomBytes(16).toString("hex")}`,"-out","server.pem","-days","7","-sha256","-extfile","server.ext"]);
    return await readPhoneCertificate(directory,host);
  } finally {await lock.close();await unlink(path.join(directory,"prepare.lock"));}
}

export function appleProfile(certificate,fingerprint) {
  // Certificate payload only: no device management, restrictions, network or credentials.
  const hex=fingerprint.replaceAll(":","").toLowerCase(),uuid=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>PayloadType</key><string>Configuration</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.moneycoach.test.${hex}</string><key>PayloadUUID</key><string>${uuid}</string>
<key>PayloadDisplayName</key><string>Money Coach local test CA (7 days)</string>
<key>PayloadDescription</key><string>Local Wi-Fi testing only. Compare the SHA-256 fingerprint with your PC. Remove this certificate profile after testing.</string>
<key>PayloadRemovalDisallowed</key><false/><key>PayloadContent</key><array><dict>
<key>PayloadType</key><string>com.apple.security.root</string><key>PayloadVersion</key><integer>1</integer>
<key>PayloadIdentifier</key><string>local.moneycoach.ca.${hex}</string><key>PayloadUUID</key><string>${uuid.slice(0,-1)}${uuid.endsWith("0") ? "1" : "0"}</string>
<key>PayloadDisplayName</key><string>Money Coach local test CA</string>
<key>PayloadContent</key><data>${certificate.toString("base64")}</data>
</dict></array></dict></plist>`;
}
