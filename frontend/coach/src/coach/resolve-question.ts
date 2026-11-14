import {interpretQuestion,type FinancialIntent} from "./intent";
import {categoryAliases} from "./query-language";
import {basketSelector} from "./basket-language";
import {questionContextSchema,isFollowUpQuestion,type QuestionContext} from "./question-context";
import {isCalendarMonth,monthPeriod,snapshot,periodSchema,type TransactionFilters,type TransactionStatusFilter,type Period} from "@/engine";

function intentFromContext(context:QuestionContext):FinancialIntent {
  const {tool,input}=context,period=periodSchema.parse(input.period);
  const scope:TransactionFilters={};
  if(input.basket!==undefined) scope.basket=input.basket as TransactionFilters["basket"];
  if(typeof input.category==="string") scope.category=input.category;
  if(typeof input.merchant==="string") scope.merchant=input.merchant;
  if(tool==="showTransactions") return {status:"ready",tool,period,scope};
  if(tool==="showFilter") return {status:"ready",tool,period,scope,value:input.value as TransactionStatusFilter};
  if(tool==="showWhatIf") return {status:"ready",tool,period,category:input.category as string,pct:input.pct as number};
  if(tool==="showBenchmark") return {status:"ready",tool,period,category:input.category as string};
  if(tool==="peerComparison") return {status:"ready",tool,period,metric:input.metric as import("@/engine/peer-comparison").PeerMetric};
  return {status:"ready",tool,period};
}

/** A follow-up changes one selector dimension. Independent questions never inherit previous selectors. */
export function resolveQuestion(question:string,context?:QuestionContext,period?:Period,referenceDate=snapshot):FinancialIntent {
  const independent=interpretQuestion(question,period,referenceDate);
  if(independent.status==="ready" || !isFollowUpQuestion(question) || independent.reason==="INVALID_QUESTION") return independent;
  const clarify=(reason="FOLLOW_UP_SCOPE_REQUIRED"):FinancialIntent=>({status:"clarification_required",reason});
  const checked=questionContextSchema.safeParse(context);if(!checked.success) return clarify("FOLLOW_UP_CONTEXT_REQUIRED");
  const text=question.trim().replace(/\?$/u,"").trim().replace(/^(?:and|what about|entä|aga)\s+/iu,"");
  const previous=checked.data;
  if(/^(?:the )?month before$/iu.test(text)) {
    const before=monthPeriod((previous.input.period as Period).start,-1);
    return intentFromContext({...previous,input:{...previous.input,period:before}});
  }
  let periodRead=interpretQuestion(`Show transactions ${text}`,undefined,referenceDate);
  if(periodRead.status!=="ready") periodRead=interpretQuestion(`Show transactions in ${text}`,undefined,referenceDate);
  let next:QuestionContext|undefined;
  if(periodRead.status==="ready" && periodRead.tool==="showTransactions" && Object.keys(periodRead.scope).length===0) {
    if((previous.tool==="showWhatIf" || previous.tool==="showBenchmark") && !isCalendarMonth(periodRead.period)) return clarify("MONTH_REQUIRED");
    next={...previous,input:{...previous.input,period:periodRead.period}};
  } else {
    const percentage=text.match(/^(?:at )?(\d{1,3}(?:[.,]\d{1,2})?)%$/iu);
    if(percentage) {
      if(previous.tool!=="showWhatIf") return clarify();
      next={...previous,input:{...previous.input,pct:Number(percentage[1].replace(",","."))}};
    } else {
      const categoryText=text.replace(/^for /iu,"").toLowerCase();
      const category=Object.hasOwn(categoryAliases,categoryText) ? categoryAliases[categoryText] : undefined;
      const basket=basketSelector(text);
      if(basket) {
        next=previous.tool==="peerComparison" ? {...previous,input:{...previous.input,metric:basket}} : previous.tool==="showTransactions" || previous.tool==="showFilter" ? {...previous,input:{...previous.input,basket}} : {tool:"showTransactions",input:{period:previous.input.period,basket}};
      } else if(category) {
        if(previous.tool==="peerComparison") next={...previous,input:{...previous.input,metric:category}};
        else if(["showTransactions","showFilter","showWhatIf","showBenchmark"].includes(previous.tool)) next={...previous,input:{...previous.input,category}};
        else next={tool:"showTransactions",input:{period:previous.input.period,category}};
      } else if(/^(?:at|paikassa|kaupmehelt) "/iu.test(text) && (previous.tool==="showTransactions" || previous.tool==="showFilter")) {
        const merchant=interpretQuestion(`Show transactions ${text}`,undefined,referenceDate);
        let literal:unknown;try {literal=JSON.parse(text.replace(/^(?:at|paikassa|kaupmehelt) /iu,""));} catch {return clarify();}
        if(typeof literal==="string" && merchant.status==="ready" && merchant.tool==="showTransactions" && merchant.scope.merchant===literal && !merchant.scope.category) next={...previous,input:{...previous.input,merchant:merchant.scope.merchant}};
      }
    }
  }
  const result=questionContextSchema.safeParse(next);
  return result.success ? intentFromContext(result.data) : clarify();
}
