import {emptyScope} from "@/engine/data-scope";
import {z} from "zod";
import {propsSchemas,type CoachMessage,type ToolName} from "@/coach/catalog";
import {COACH_REVISION} from "@/coach/transport";
import type {Locale} from "@/i18n/dictionaries";
const text=z.object({type:z.literal("text"),text:z.string().max(10000)});
const row=z.object({id:z.string().min(1).max(200),role:z.enum(["user","assistant"]),parts:z.array(z.unknown()).max(30),metadata:z.object({answerMode:z.enum(["model","rule"]),language:z.enum(['en','fi','et','es','ja']).optional(),provider:z.literal('gemma-local').optional()}).optional()});
export const threadKey=(locale:Locale)=>`money-coach-thread.v1.${locale}`;
/** Browser storage is untrusted and bounded. Never restores different-build tool figures. */
export function decodeThread(raw:string|null,locale:Locale,signature=JSON.stringify(emptyScope)):CoachMessage[] {
 if(!raw || raw.length>250000) return [];
 try {
  const value=z.object({revision:z.literal(COACH_REVISION),locale:z.literal(locale),scopeSignature:z.literal(signature),messages:z.array(row).max(60)}).parse(JSON.parse(raw));
  const seen=new Set<string>(),messages:CoachMessage[]=[];
  for(const message of value.messages) {
   if(seen.has(message.id)) continue;seen.add(message.id);
   const parts=[];
   for(const part of message.parts) {
    const step=z.object({type:z.literal("step-start")}).strict().safeParse(part);if(step.success){parts.push(step.data);continue;}
    const plain=text.safeParse(part);if(plain.success) {parts.push(plain.data);continue;}
    const tool=z.object({type:z.string(),toolCallId:z.string().min(1).max(200),state:z.literal("output-available"),input:z.unknown(),output:z.unknown()}).parse(part);
    const name=tool.type.slice(5) as ToolName;
    if(!tool.type.startsWith("tool-") || !Object.hasOwn(propsSchemas,name) || message.role!=="assistant") throw new Error("Invalid stored result");
    parts.push({...tool,output:propsSchemas[name].parse(tool.output)});
   }
   messages.push({...message,parts} as CoachMessage);
  }
  return messages;
 }catch{return [];}
}
export function encodeThread(messages:CoachMessage[],locale:Locale,signature=JSON.stringify(emptyScope)):string|null {
 const raw=JSON.stringify({revision:COACH_REVISION,locale,scopeSignature:signature,messages:messages.filter(message=>message.parts.every(part=>part.type==="text" || part.type==="step-start" || ("state" in part && part.state==="output-available"))).slice(-60)});
 return raw.length<=250000 ? raw : null;
}
