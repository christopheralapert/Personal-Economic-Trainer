import {createServer} from "node:net";
import {fork,spawn} from "node:child_process";
import {once} from "node:events";
import {fileURLToPath} from "node:url";

const root=fileURLToPath(new URL("../",import.meta.url));
// Use the actual Next application with a parent-owned process. This also avoids
// relying on shell process-tree termination when tests finish on Windows.
if(process.argv[2]==="--server"){
 const {createServer: httpServer}=await import("node:http");
 const {default:next}=await import("next");
 const app=next({dev:true,webpack:true,hostname:"127.0.0.1",port:Number(process.env.MONEYLENS_VOICE_TEST_PORT),dir:fileURLToPath(new URL("../frontend/web",import.meta.url))});
 await app.prepare();
 const server=httpServer(app.getRequestHandler());
 server.listen(Number(process.env.MONEYLENS_VOICE_TEST_PORT),"127.0.0.1",()=>process.send?.("ready"));
 const close=async()=>{server.closeAllConnections();server.close();await app.close();process.exit(0);};
 process.once("message",()=>void close());process.once("disconnect",()=>void close());
}else{
// Isolate this suite from other worktrees and running development servers.
const reservation=createServer();
await new Promise((resolve,reject)=>{reservation.once("error",reject);reservation.listen(0,"127.0.0.1",resolve);});
const {port}=reservation.address();
await new Promise((resolve,reject)=>reservation.close(error=>error ? reject(error) : resolve()));
const env={...process.env,MONEYLENS_VOICE_TEST_PORT:String(port),NEXT_TELEMETRY_DISABLED:"1",GEMINI_API_KEY:"",OPENAI_API_KEY:"",MONEY_COACH_PUBLIC_GEMINI_ENABLED:"false",MONEY_COACH_GEMINI_VOICE_ENABLED:"false"};
const server=fork(fileURLToPath(import.meta.url),["--server"],{cwd:root,stdio:["ignore","inherit","inherit","ipc"],windowsHide:true,env});
let tests;
const stop=()=>{tests?.kill();server.kill();};
process.once("SIGINT",stop);process.once("SIGTERM",stop);
try{
 await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{server.kill();reject(new Error("Voice test server startup timed out"));},120000);
  server.once("error",error=>{clearTimeout(timeout);reject(error);});
  server.once("exit",code=>{clearTimeout(timeout);reject(new Error(`Voice test server exited: ${code}`));});
  server.once("message",()=>{clearTimeout(timeout);resolve();});
 });
 console.log(`Voice test server: http://127.0.0.1:${port}/demo`);
 tests=spawn(process.execPath,["node_modules/@playwright/test/cli.js","test","--config","tests/config/playwright.voice.config.ts",...process.argv.slice(2)],{
  cwd:root,stdio:"inherit",windowsHide:true,env,
 });
 tests.once("error",error=>{console.error(error);process.exitCode=1;});
 const [code]=await once(tests,"exit");process.exitCode=code??1;
}finally{
 if(server.exitCode===null && server.signalCode===null){
  const exited=once(server,"exit");
  if(server.connected)server.send("stop");
  const timeout=setTimeout(()=>server.kill(),5000);await exited;clearTimeout(timeout);
 }
 process.removeListener("SIGINT",stop);process.removeListener("SIGTERM",stop);
}
}
