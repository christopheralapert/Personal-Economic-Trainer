import {createUIMessageStream,createUIMessageStreamResponse} from "ai";
import {z} from "zod";
import {executeCoach} from "@/coach/server-executor";
import {CoachRequestError,readCoachJSON} from "@/coach/request";
import {COACH_REVISION,REVISION_HEADER} from "@/coach/transport";
import {CoachCancelledError} from "@/coach/execution";
import {questionContextSchema} from "@/coach/question-context";
import {dataScopeSchema,scopedDataset} from "@/engine/data-scope";
import {loadDataset,datasetKeySchema} from "@/engine/datasets";
import {periodSchema} from "@/engine";
const bodySchema=z.object({dataset:datasetKeySchema.optional(),scope:dataScopeSchema.optional(),period:periodSchema.optional(),context:questionContextSchema.optional(),messages:z.array(z.object({role:z.enum(["user","assistant","system"]),parts:z.array(z.object({type:z.string(),text:z.string().max(2000).optional()}).passthrough()).max(30)}).passthrough()).min(1).max(50),locale:z.enum(["en","fi","et"]).default("en"),savingsPercent:z.number().int().min(0).max(100).default(10)}).passthrough();
const latestSchema=z.object({role:z.literal("user"),parts:z.array(z.object({type:z.literal("text"),text:z.string().max(2000)}).strict()).min(1).max(30)}).passthrough();
function rejected(status:number) {return new Response(null,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",[REVISION_HEADER]:COACH_REVISION}});}
export function createChatRoute(execute=executeCoach) {
 return async function POST(request:Request) {
  const origin=request.headers.get("origin");
  if(origin) {try {const parsed=new URL(origin);if(!["http:","https:"].includes(parsed.protocol) || parsed.host!==request.headers.get("host")) return rejected(403);} catch {return rejected(403);}}
  if(!COACH_REVISION) return rejected(503);
  if(request.headers.get(REVISION_HEADER)!==COACH_REVISION) return rejected(409);
  let body:z.infer<typeof bodySchema>;
  try {body=bodySchema.parse(await readCoachJSON(request));if(body.scope)scopedDataset(await loadDataset(body.dataset??"starter"),body.scope);} catch(error) {return rejected(error instanceof CoachRequestError ? error.status : 400);}
  const latest=latestSchema.safeParse(body.messages.at(-1));if(!latest.success) return rejected(400);
  const question=latest.data.parts.map(p=>p.text).join(" ").trim();if(!question || question.length>2000) return rejected(400);
  if(request.signal.aborted) return rejected(400);
  let outcome;
  try {outcome=await execute(request,question,body.locale,body.savingsPercent,body.context,body.period,body.scope,body.dataset);}
  catch(error) {if(error instanceof CoachCancelledError) return rejected(400);throw error;}
  if(request.signal.aborted) return rejected(400);
  const answer=outcome.message;
  const stream=createUIMessageStream({execute:({writer})=>{
    writer.write({type:"start",messageId:answer.id});
    writer.write({type:"start-step"});
    for(const [i,part] of answer.parts.entries()) {
      if(part.type==="text") {const id=`${answer.id}-${i}`;writer.write({type:"text-start",id});writer.write({type:"text-delta",id,delta:part.text});writer.write({type:"text-end",id});}
      else if(part.type.startsWith("tool-") && "toolCallId" in part && part.state==="output-available") {
        writer.write({type:"tool-input-available",toolCallId:part.toolCallId,toolName:part.type.slice(5),input:part.input});
        writer.write({type:"tool-output-available",toolCallId:part.toolCallId,output:part.output});
      }
    }
    writer.write({type:"finish-step"});writer.write({type:"finish"});
  }});
  const provider:Record<string,string>="provider" in outcome && outcome.provider ? {"X-Money-Coach-Provider":outcome.provider} : {};
  const usage:Record<string,string>="usageDiagnostic" in outcome && outcome.usageDiagnostic ? {"X-Money-Coach-Usage":JSON.stringify(outcome.usageDiagnostic)} : {};
  return createUIMessageStreamResponse({stream,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",[REVISION_HEADER]:COACH_REVISION,"X-Money-Coach-Source":outcome.source,"X-Money-Coach-Evaluation":outcome.diagnostic,...provider,...usage}});
}
}
