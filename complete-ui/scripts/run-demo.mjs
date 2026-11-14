import {spawn} from "node:child_process";
import {isIP} from "node:net";
import {parseArgs} from "node:util";
import {fileURLToPath,pathToFileURL} from "node:url";
import path from "node:path";
import {runtimeEnvironment,verifyRelease} from "./release-lib.mjs";

export function releaseOptions(args) {
  let values;try {({values}=parseArgs({args,options:{host:{type:"string",default:"127.0.0.1"},port:{type:"string",default:"3001"}},strict:true}));} catch {throw new Error("Use --host <IP> and --port <1024-65535>");}
  const port=/^\d+$/.test(values.port) ? Number(values.port) : NaN;
  if(!isIP(values.host) || !Number.isInteger(port) || port<1024 || port>65535) throw new Error("Choose an IP address and port 1024-65535");
  return {host:values.host,port};
}
export async function runDemo(args) {
  const options=releaseOptions(args),root=path.dirname(fileURLToPath(import.meta.url));
  const manifest=await verifyRelease(root);
  const app=path.join(root,"apps/money-coach"),child=spawn(process.execPath,[path.join(app,"server.js")],{cwd:app,env:runtimeEnvironment(process.env,options),stdio:"inherit",windowsHide:true});
  process.stdout.write(`Money Coach synthetic demo ${manifest.revision.slice(0,12)}; model calls disabled.\n`);
  const forward=signal=>{if(!child.killed) child.kill(signal);};
  const interrupt=()=>forward("SIGINT"),terminate=()=>forward("SIGTERM");
  process.on("SIGINT",interrupt);process.on("SIGTERM",terminate);
  child.once("error",()=>{process.stderr.write("Demo process could not start.\n");process.exitCode=1;});
  child.once("exit",code=>{process.off("SIGINT",interrupt);process.off("SIGTERM",terminate);process.exitCode=code ?? 1;});
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) runDemo(process.argv.slice(2)).catch(()=>{process.stderr.write("Demo startup refused: check artifact integrity, runtime and host/port.\n");process.exitCode=1;});
