import type {Key} from "@/i18n/dictionaries";
import type {CoachMessage,ToolName} from "./catalog";

const next:Partial<Record<ToolName,readonly [Key,Key]>>={
  peerComparison:["qFollowCategory","qBaskets"],showTransactions:["qDonut","qWhatif"],showDonut:["qFollowCategory","qWhatif"],showCategories:["qBaskets","qWhatif"],
  showBaskets:["qFollowBasket","qSafe"],showWhatIf:["qFollowPercent","qProfile"],showSafeToSpend:["qLearn","qBaskets"],showPayday:["qPaydayLate","qPaydayPurchase"],
  showProfile:["qDonut","qCompare"],showBenchmark:["qProfile","qWhatif"],showConcept:["qSafe","qBaskets"],
  showDetails:["qBaskets","qWhatif"],showFilter:["qDonut","qSafe"],showStepper:["qLearn","qWhatif"],
};
export function followUps(messages:CoachMessage[]):readonly [Key,Key] {
  for(let i=messages.length-1;i>=0;i--) {
    if(messages[i].role!=="assistant") continue;
    for(const part of messages[i].parts) {
      if(part.type==="tool-showSafeToSpend" && part.state==="output-available") return part.output.purpose==="save" ? ["qSafe","qWhatif"] : ["qPayday","qSave"];
      if(part.type.startsWith("tool-") && "state" in part && part.state==="output-available")
      return next[part.type.slice(5) as ToolName] ?? ["qTaxi","qWhatif"];
    }
    break;
  }
  return ["qTaxi","qWhatif"];
}
