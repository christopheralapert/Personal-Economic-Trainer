import "server-only";
import {mkdir,open,readFile,rename,unlink,writeFile} from "node:fs/promises";
import path from "node:path";
import {z} from "zod";
import {VoiceError,type VoiceUsage} from "./provider";
const entry=z.object({operation:z.enum(["transcribe","speak","coach"]),at:z.string(),status:z.enum(["reserved","complete","failed"]),usage:z.object({total_input_tokens:z.number().int().nonnegative(),total_output_tokens:z.number().int().nonnegative(),total_tokens:z.number().int().positive()}).optional()});
const count=z.number().int().nonnegative().safe();
const schema=z.object({version:z.literal(2),attempts:count,completed:count,failed:count,inputTokens:count,outputTokens:count,totalTokens:count,recent:z.array(entry).max(50)}).strict();
const legacy=z.object({version:z.literal(1),attempts:z.array(entry).max(1000)}).strict();
/** Reservations survive failures/restarts. No prompts, audio, keys or identities. */
export async function withVoiceReservation<T extends {usage:VoiceUsage|null}>(file:string,maximum:number|null,operation:"transcribe"|"speak"|"coach",run:()=>Promise<T>):Promise<T>{
 if(!path.isAbsolute(file) || (maximum!==null && (!Number.isInteger(maximum) || maximum<1 || maximum>100)))throw new VoiceError("voice_disabled",503);
 await mkdir(path.dirname(file),{recursive:true});
 let lock;try{lock=await open(file+".lock","wx",0o600);}catch{throw new VoiceError("voice_busy",429,"5");}
 let state:z.infer<typeof schema>={version:2,attempts:0,completed:0,failed:0,inputTokens:0,outputTokens:0,totalTokens:0,recent:[]};
 const save=async()=>{await writeFile(file+".next",JSON.stringify(state),{mode:0o600});await rename(file+".next",file);};
 try {
  try{
   const raw=JSON.parse(await readFile(file,"utf8"));
   if(raw.version===1){const old=legacy.parse(raw).attempts;state={...state,attempts:old.length,completed:old.filter(e=>e.status==="complete").length,failed:old.filter(e=>e.status==="failed").length,inputTokens:old.reduce((n,e)=>n+(e.usage?.total_input_tokens??0),0),outputTokens:old.reduce((n,e)=>n+(e.usage?.total_output_tokens??0),0),totalTokens:old.reduce((n,e)=>n+(e.usage?.total_tokens??0),0),recent:old.slice(-50)};}
   else state=schema.parse(raw);
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw new VoiceError("voice_ledger",503);}
  if(maximum!==null && state.attempts>=maximum)throw new VoiceError("voice_limit",429);
  const current:z.infer<typeof entry>={operation,at:new Date().toISOString(),status:"reserved"};state.attempts++;state.recent.push(current);state.recent=state.recent.slice(-50);await save();
  let result:T;try{result=await run();}catch(error){current.status="failed";state.failed++;await save();throw error;}
  current.status=result.usage ? "complete" : "failed";if(result.usage){current.usage=result.usage;state.completed++;state.inputTokens+=result.usage.total_input_tokens;state.outputTokens+=result.usage.total_output_tokens;state.totalTokens+=result.usage.total_tokens;}else state.failed++;await save();return result;
 } finally {await lock.close();await unlink(file+".lock");}
}
