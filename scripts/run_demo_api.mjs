// A separate, database-free synthetic service. Never inherits application secrets.
import {spawn} from "node:child_process";
import path from "node:path";
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith("MONEYLENS_")));
Object.assign(env,{MONEYLENS_ENVIRONMENT:"development",MONEYLENS_AUTH_ENABLED:"false",MONEYLENS_ALLOW_DEMO:"true",MONEYLENS_LIVE_BANKING_ENABLED:"false",MONEYLENS_MODEL_ENABLED:"false",MONEYLENS_MODEL_BILLING_POLICY:"free_only"});
const python=path.resolve(process.platform==="win32"?".venv/Scripts/python.exe":".venv/bin/python");
const child=spawn(python,["-m","uvicorn","app.main:app","--app-dir","backend/api","--host","127.0.0.1","--port","8001","--no-access-log"],{env,stdio:"inherit",windowsHide:true});
child.on("error",()=>{console.error("Synthetic demo API could not start.");process.exitCode=1;});child.on("exit",code=>{process.exitCode=code??0;});for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
