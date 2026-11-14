import {propsSchemas,type CoachMessage} from "./catalog";
import {questionContextSchema,contextualTools,type QuestionContext} from "./question-context";
import {resultViewName,viewStateKey,type ViewStore} from "@/lib/view-store";

const object=(value:unknown):value is Record<string,unknown>=>value!==null && typeof value==="object" && !Array.isArray(value);

/** Read only selectors from the latest completed result, including confirmed visit-only edits. */
export function displayedContext(messages:CoachMessage[],views:ViewStore):QuestionContext|undefined {
  const message=messages.at(-1);if(!message || message.role!=="assistant") return;
  const results=message.parts.filter(part=>part.type.startsWith("tool-") && "state" in part && part.state==="output-available");
  if(results.length!==1) return;
  const part=results[0];if(!("output" in part) || !("input" in part) || !("toolCallId" in part) || typeof part.toolCallId!=="string" || !object(part.output)) return;
  const tool=part.type.slice(5);if(!(contextualTools as readonly string[]).includes(tool)) return;
  if((tool==="showTransactions" || tool==="showFilter") && !propsSchemas[tool].safeParse(part.output).success) return;
  const base=questionContextSchema.safeParse({tool,input:part.input});if(!base.success) return;
  const output=part.output,name=resultViewName(message.id,part.toolCallId);
  const read=(field:string,fallback:unknown)=>views.peek(viewStateKey(name,field)) ?? fallback;
  let input:Record<string,unknown>={...base.data.input};
  if(tool==="showDonut" || tool==="showDetails") input.period=read("period",output.period);
  else if(tool==="showCategories" || tool==="showBaskets") input.period=output.period;
  else if(tool==="showTransactions") {if(!object(output.filters)) return;input={period:output.period,...output.filters};}
  else if(tool==="showFilter") {
    const filters=read("filters",output.filters);if(!object(filters)) return;
    input={period:read("historyPeriod",output.period),value:read("status",output.value),...filters};
  } else if(tool==="showWhatIf") {
    if(!object(output.period) || typeof output.category!=="string") return;
    input={period:output.period,category:output.category,pct:read(`pct:${output.category}/${output.period.start}/${output.period.end}`,output.initialPct)};
  } else if(tool==="showProfile" || tool==="showBenchmark") {
    if(!object(output.result)) return;input.period=output.result.period;
    if(tool==="showBenchmark") input.category=output.result.category;
  }
  const checked=questionContextSchema.safeParse({tool,input});return checked.success ? checked.data : undefined;
}
