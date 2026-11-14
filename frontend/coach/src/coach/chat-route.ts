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
import {acknowledgement,conversationLanguage,languageCommand,languageConfirmation,localLanguageUnavailable} from './conversation-language';
import type {CoachMessage} from './catalog';
const bodySchema=z.object({dataset:datasetKeySchema.optional(),scope:dataScopeSchema.optional(),period:periodSchema.optional(),context:questionContextSchema.optional(),privacy:z.boolean().default(true),messages:z.array(z.object({role:z.enum(["user","assistant","system"]),parts:z.array(z.object({type:z.string(),text:z.string().max(2000).optional()}).passthrough()).max(30)}).passthrough()).min(1).max(50),locale:z.enum(["en","fi","et"]).default("en"),savingsPercent:z.number().int().min(0).max(100).default(10)}).passthrough();
const latestSchema=z.object({role:z.literal("user"),parts:z.array(z.object({type:z.literal("text"),text:z.string().max(2000)}).strict()).min(1).max(30)}).passthrough();
function rejected(status:number) {return new Response(null,{status,headers:{"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff",[REVISION_HEADER]:COACH_REVISION}});}
export function createChatRoute(execute=executeCoach) {
 return async function POST(request:Request) {
  const origin=request.headers.get("origin");
  if(origin) {try {const parsed=new URL(origin);if(!["http:","https:"].includes(parsed.protocol) || parsed.host!==request.headers.get("host")) return rejected(403);} catch {return rejected(403);}}
  if(!COACH_REVISION) return rejected(503);
  if(request.headers.get(REVISION_HEADER)!==COACH_REVISION) return rejected(409);
  let body:z.infer<typeof bodySchema>;
  try {body=bodySchema.parse(await readCoachJSON(request));} catch(error) {return rejected(error instanceof CoachRequestError ? error.status : 400);}
  const latest=latestSchema.safeParse(body.messages.at(-1));if(!latest.success) return rejected(400);
  const question=latest.data.parts.map(p=>p.text).join(" ").trim();if(!question || question.length>2000) return rejected(400);
  if(request.signal.aborted) return rejected(400);
  const command=languageCommand(question),language=command?.language??conversationLanguage(body.conversationLanguage,body.locale),query=command?.question||question;
  const localText=command && !command.question?languageConfirmation[language]:acknowledgement(query,language)??(body.privacy && !['en','fi','et'].includes(language)?localLanguageUnavailable(body.locale):null);
  let outcome;
  try {
   if(localText)outcome={message:{id:crypto.randomUUID(),role:'assistant',parts:[{type:'text',text:localText}]} as CoachMessage,source:'rule' as const,diagnostic:'conversation_control'};
   else {if(body.scope)scopedDataset(await loadDataset(body.dataset??'starter'),body.scope);outcome=await execute(request,query,['en','fi','et'].includes(language)?language as typeof body.locale:body.locale,body.savingsPercent,body.context,body.period,body.scope,body.dataset,body.privacy);}
  }
  // Keep framework error pages and execution details out of the chat transport.
  catch(error) {return rejected(error instanceof CoachCancelledError || request.signal.aborted ? 400 : 503);}
  if(request.signal.aborted) return rejected(400);
  const answer=outcome.message;
  if(language==='es' || language==='ja')answer.parts=answer.parts.map(part=>part.type==='text'?{...part,text:localText??(language==='es'?'Consulta los resultados registrados a continuación.':'以下の記録された結果をご確認ください。')}:part);
  const stream=createUIMessageStream({execute:({writer})=>{
    writer.write({type:"start",messageId:answer.id,messageMetadata:{answerMode:outcome.source,language}});
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
