import {createServer as createHTTPServer} from "node:http";
import {createServer as createHTTPSServer} from "node:https";
import {networkInterfaces} from "node:os";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
import {preparePhoneCertificate,certificateRoot,privateAddress,appleProfile} from "./phone-certificate.mjs";
import {coachRevision} from "./revision.mjs";
import {randomBytes} from "node:crypto";
import {openBudget,liveDirectory} from "./live-budget.mjs";
import {phoneCookieMatches} from "./phone-ai-access.mjs";

const appDirectory=fileURLToPath(new URL("../",import.meta.url));
export function phoneOptions(args) {
  const options={host:"",port:3443,setupPort:3444};
  for(let i=0;i<args.length;i+=2) {
    const name={"--host":"host","--port":"port","--setup-port":"setupPort"}[args[i]],value=args[i+1];
    if(!name || !value) throw new Error("Use --host <private IPv4> [--port 3443] [--setup-port 3444].");
    options[name]=name==="host" ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  }
  if(!privateAddress(options.host) || ![options.port,options.setupPort].every(n=>Number.isInteger(n) && n>=1024 && n<=65535) || options.port===options.setupPort) throw new Error("Choose one private IPv4 address and two different ports between 1024 and 65535.");
  return options;
}
export function disablePhoneModel(env) {
  return {...env,NODE_ENV:"production",NEXT_TELEMETRY_DISABLED:"1",MONEYLENS_MODEL_BILLING_POLICY:"free_only",MONEY_COACH_LOCAL_AI_EVALUATION:"false",MONEY_COACH_LOCAL_AI_ORIGIN:"",MONEY_COACH_EVALUATION_DIRECTORY:"",MONEYLENS_OPENAI_API_KEY:"",OPENAI_API_KEY:"",MONEY_COACH_PHONE_AI_EVALUATION:"false",MONEY_COACH_PHONE_AI_SECRET:""};
}
function deny(response,status=404) {response.writeHead(status,{"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});response.end();}
export function setupHandler({host,setupPort,origin,material}) {
  const files=new Map([
    ["/money-coach-ca.cer",{type:"application/x-x509-ca-cert",body:material.certificate}],
    ["/money-coach.mobileconfig",{type:"application/x-apple-aspen-config",body:Buffer.from(appleProfile(material.certificate,material.fingerprint))}],
    ["/",{type:"text/plain; charset=utf-8",body:Buffer.from(`Money Coach local phone preview\n\nApp: ${origin}\nAndroid certificate: http://${host}:${setupPort}/money-coach-ca.cer\niPhone profile: http://${host}:${setupPort}/money-coach.mobileconfig\n\nVerify this CA SHA-256 fingerprint against the PC before trusting it:\n${material.fingerprint}\nValid until: ${material.expiresAt}\n\nThis installs a local test trust certificate. Remove it after testing.\nThe iPhone also needs Settings > General > About > Certificate Trust Settings.\nThe HTTP endpoint serves only these public certificate files; no private keys or app/API.\n`)}],
  ]);
  return (request,response)=>{
    if(request.headers.host!==`${host}:${setupPort}`) return deny(response,403);
    if(!["GET","HEAD"].includes(request.method)) return deny(response,405);
    const file=files.get(request.url);if(!file) return deny(response);
    response.writeHead(200,{"Content-Type":file.type,"Content-Length":file.body.length,"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"});
    response.end(request.method==="HEAD" ? undefined : file.body);
  };
}
function tune(server) {server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=5000;server.maxHeadersCount=100;server.maxConnections=64;}
async function listen(server,port,host) {
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(port,host,()=>{server.removeListener("error",reject);resolve();});});
}
export async function startPhonePreview(options) {
  const {host,port,setupPort}=options;
  const assigned=Object.values(networkInterfaces()).flat().some(item=>item?.address===host);
  if(!privateAddress(host) || !assigned) throw new Error("The chosen private IPv4 address is not assigned to this PC. Check Wi-Fi and --host.");
  // Explicit values prevent Next dotenv files or inherited live flags from enabling paid traffic.
  const phoneAI=process.env.MONEY_COACH_PHONE_AI_EVALUATION==="true",evaluationKey=process.env.MONEYLENS_OPENAI_API_KEY;
  Object.assign(process.env,disablePhoneModel(process.env));
  const revision=coachRevision();
  let built;
  try {built=JSON.parse(await readFile(path.join(appDirectory,".next/required-server-files.json"),"utf8"));} catch {throw new Error("Run npm run build:coach before the phone preview.");}
  if(built.config.env.NEXT_PUBLIC_MONEY_COACH_REVISION!==revision) throw new Error("The production build is stale. Run npm run build:coach before the phone preview.");
  const directory=path.join(certificateRoot,host),material=await preparePhoneCertificate({directory,host}),origin=`https://${host}:${port}`;
  let pairingSecret="",evaluationExpiry;
  if(phoneAI) {
    const state=JSON.parse(await readFile(path.join(liveDirectory,"allowance.json"),"utf8"));
    if(state.phoneEvaluationAuthorized!==true || state.phoneStartAttempts!==40 || state.maxAttempts!==60) throw new Error("A current phone evaluation grant is required.");
    const budget=await openBudget({key:evaluationKey,requiredOrigin:origin,requiredRevision:revision});
    evaluationExpiry=Date.parse(budget.summary().expiresAt);await budget.close();pairingSecret=randomBytes(32).toString("hex");
    Object.assign(process.env,{MONEYLENS_OPENAI_API_KEY:evaluationKey,MONEY_COACH_LOCAL_AI_EVALUATION:"true",MONEY_COACH_PHONE_AI_EVALUATION:"true",MONEY_COACH_PHONE_AI_SECRET:pairingSecret,MONEY_COACH_LOCAL_AI_ORIGIN:origin,MONEY_COACH_EVALUATION_DIRECTORY:liveDirectory});
  }
  // Next's config transpiler resolves relative config imports from the process cwd.
  // Match the workspace CLI even when this launcher is started from the repo root.
  process.chdir(appDirectory);
  const {default:next}=await import("next");
  const app=next({dev:false,dir:appDirectory,hostname:host,port,quiet:true});
  await app.prepare();const handle=app.getRequestHandler();
  const secure=createHTTPSServer({key:material.key,cert:material.cert,minVersion:"TLSv1.2",maxHeaderSize:16384},(request,response)=>{
    if(request.headers.host!==`${host}:${port}`) return deny(response,403);
    if(phoneAI && request.method==="GET") {
      const url=new URL(request.url,origin),access=url.searchParams.get("coachAccess");
      if(access!==null) {
        if(!phoneCookieMatches(`__Host-coach-evaluation=${access}`,pairingSecret) || Date.now()>=evaluationExpiry) return deny(response,403);
        url.searchParams.delete("coachAccess");
        response.writeHead(303,{Location:url.pathname+url.search,"Set-Cookie":`__Host-coach-evaluation=${pairingSecret}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(0,Math.floor((evaluationExpiry-Date.now())/1000))}`,"Cache-Control":"no-store","Referrer-Policy":"no-referrer"});response.end();return;
      }
    }
    if(phoneAI && request.method==="POST" && (!phoneCookieMatches(request.headers.cookie,pairingSecret) || Date.now()>=evaluationExpiry)) return deny(response,403);
    const pathname=request.url?.split("?")[0];
    const publicRead=["/","/kit","/sw.js","/manifest.webmanifest","/icon.svg","/icon-192.png","/icon-512.png","/icon-maskable.png","/apple-touch-icon.png"].includes(pathname) || /^\/_next\/static\/[A-Za-z0-9_./%-]+$/.test(pathname ?? "");
    if(!(["GET","HEAD"].includes(request.method) && publicRead) && !(request.method==="POST" && pathname==="/api/chat" && request.headers.origin===origin)) return deny(response);
    Promise.resolve(handle(request,response)).catch(()=>{if(!response.headersSent) deny(response,500);else response.destroy();});
  });
  const setup=createHTTPServer({maxHeaderSize:16384},setupHandler({host,setupPort,origin,material}));
  tune(secure);tune(setup);
  async function close() {secure.closeAllConnections();setup.closeAllConnections();await Promise.all([new Promise(resolve=>secure.close(resolve)),new Promise(resolve=>setup.close(resolve))]);await app.close();}
  try {await listen(secure,port,host);await listen(setup,setupPort,host);} catch {await close();throw new Error("The phone preview ports are unavailable. Stop the other preview or choose two unused ports.");}
  const details={origin,setup:`http://${host}:${setupPort}`,fingerprint:material.fingerprint,expiresAt:material.expiresAt,revision,provider:phoneAI ? "bounded_evaluation" : "rule",pid:process.pid,...(phoneAI ? {pairingURL:`${origin}/?dataset=extended&coachAccess=${pairingSecret}`,evaluationExpiresAt:new Date(evaluationExpiry).toISOString()} : {})};
  await writeFile(path.join(directory,"preview.json"),JSON.stringify(details,null,2)+"\n",{mode:0o600});
  let closing=false;
  const stop=async()=>{if(closing)return;closing=true;clearTimeout(expiry);await close();};
  const expiry=setTimeout(()=>{void stop();},Math.max(1,Math.min(Date.parse(material.expiresAt),evaluationExpiry??Infinity)-Date.now()));expiry.unref();
  return {details,close:stop};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const preview=await startPhonePreview(phoneOptions(process.argv.slice(2)));
    console.log(JSON.stringify(preview.details,null,2));
    console.log(preview.details.provider==="bounded_evaluation" ? "Paired local synthetic AI evaluation only. The existing shared cost ledger and one-hour/20-additional-request grant apply. Keep the pairing link private. Ctrl+C stops both listeners." : "Local synthetic demo only. Install and verify the public test CA on each phone; remove it after testing. Private keys stay on this PC. No AI API calls are enabled. Ctrl+C stops both listeners.");
    process.once("SIGINT",()=>{void preview.close();});process.once("SIGTERM",()=>{void preview.close();});
  } catch(error) {console.log(error instanceof Error && !/^(error:|Error:)/.test(error.message) ? error.message : "Phone preview could not start.");process.exitCode=1;}
}
