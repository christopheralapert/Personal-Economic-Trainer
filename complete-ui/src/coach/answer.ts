import {type CoachMessage,type ToolName,propsSchemas} from "./catalog";
import {exactSum,periodSchema,snapshot} from "@/engine";
import {translate,categoryLabel} from "@/i18n/translate";
import type {Locale} from "@/i18n/dictionaries";
import {date,money} from "@/lib/format";
import {hasOnlyGroundedNumbers} from "./answer-grounding";

export function answerBasis(input:Record<string,unknown>,locale:Locale):string {
  const parsed=periodSchema.safeParse(input.period);
  if(!parsed.success) return translate(locale,"demo",{date:date(snapshot)});
  const period=parsed.data,through=new Date(Date.parse(period.end+"T12:00:00Z")-86400000).toISOString().slice(0,10);
  return translate(locale,"based",{start:date(period.start),end:date(through)});
}

/** Both providers use authored framing of validated engine facts, never model prose. */
export function answerFromTool(name:ToolName,input:Record<string,unknown>,output:unknown,locale:Locale,toolCallId=crypto.randomUUID()):CoachMessage {
  const t=(key:Parameters<typeof translate>[1],values?:Record<string,string|number>)=>translate(locale,key,values);
  const checked=propsSchemas[name].parse(output);
  let framing=t("baskets");
  if(name==="peerComparison"){
    const result=propsSchemas.peerComparison.parse(checked).result;
    framing=result.status==="ready" ? t("peerAnswer",{amount:money(result.you)}) : t("peerInsufficient");
  }
  if(name==="showTransactions") {
    const result=propsSchemas.showTransactions.parse(checked);
    framing=result.total===0 ? t("emptyRecords") : result.netExpenses===null ? t("noExpenseRecords") : t(input.category==="taxi" ? "taxiAnswer" : "spendAnswer",{amount:money(result.netExpenses)});
  }
  if(name==="showDonut" || name==="showCategories" || name==="showBaskets") {
    const groups=(name==="showDonut" ? propsSchemas.showDonut.parse(checked) : name==="showBaskets" ? propsSchemas.showBaskets.parse(checked) : propsSchemas.showCategories.parse(checked)).groups;
    framing=groups.length ? t("spendAnswer",{amount:money(exactSum(groups.map(g=>g.amount)))}) : t("noExpenseRecords");
  }
  if(name==="showSummary") {
    const expenses=propsSchemas.showSummary.parse(checked).expenses;
    framing=expenses===null ? t("noExpenseRecords") : t("spendAnswer",{amount:money(expenses)});
  }
  if(name==="showWhatIf") framing=t("simulationAnswer",{amount:money(propsSchemas.showWhatIf.parse(checked).result.monthly)});
  if(name==="showProfile") {
    const profile=propsSchemas.showProfile.parse(checked).result;
    framing=profile.leading ? t("profileAnswer",{category:categoryLabel(profile.leading.key,t)}) : t("noPattern");
  }
  if(name==="showBenchmark") {
    const result=propsSchemas.showBenchmark.parse(checked).result;
    framing=result.you===null ? t("notAvailable") : t("benchmarkAnswer",{amount:money(result.you)});
  }
  if(name==="showSafeToSpend") framing=t(propsSchemas.showSafeToSpend.parse(checked).purpose==="save" ? "safeSaveNote" : "safeNote");
  if(name==="showConcept") framing=t(propsSchemas.showConcept.parse(checked).concept);
  if(name==="showStepper") framing=t("goal");
  if(name==="showDetails") framing=t("period");
  if(name==="showFilter") framing=t("transactions");
  const groundedFraming=hasOnlyGroundedNumbers(framing,checked) ? framing : t("noExpenseRecords");
  return {id:crypto.randomUUID(),role:"assistant",parts:[{type:"text",text:groundedFraming},
    {type:`tool-${name}`,toolCallId,state:"output-available",input,output:checked} as CoachMessage["parts"][number],
    {type:"text",text:answerBasis(input,locale)+" "+t("partial")}]};
}
