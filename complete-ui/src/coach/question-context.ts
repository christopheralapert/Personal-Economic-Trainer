import {z} from "zod";
import {tools} from "./catalog";
import {periodSchema,snapshot} from "@/engine";

export const contextualTools=["showTransactions","showDonut","showCategories","showBaskets","showProfile","showWhatIf","showBenchmark","showFilter","showDetails","peerComparison"] as const;
const tomorrow=new Date(snapshot+"T12:00:00Z");tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
const through=tomorrow.toISOString().slice(0,10);
/** Selectors only. The actual closed tool schema is authoritative; financial outputs are never accepted. */
export const questionContextSchema=z.object({tool:z.enum(contextualTools),input:z.record(z.string(),z.unknown())}).strict().transform((value,ctx)=>{
  const period=periodSchema.strict().safeParse(value.input.period);
  const parsed=(tools[value.tool].inputSchema as z.ZodType<Record<string,unknown>>).safeParse(value.input);
  if(!period.success || period.data.end>through || !parsed.success) {ctx.addIssue({code:"custom",message:"Invalid previous selectors"});return z.NEVER;}
  return {tool:value.tool,input:Object.fromEntries(Object.entries(parsed.data).filter(([,item])=>item!==undefined))};
});
export type QuestionContext=z.infer<typeof questionContextSchema>;
export function isFollowUpQuestion(question:string):boolean {return /^(?:and|what about|entä|aga)(?:\s|\?|$)/iu.test(question.trim());}
