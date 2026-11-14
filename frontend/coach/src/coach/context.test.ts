import {describe,it,expect} from "vitest";
import {resolveQuestion} from "./resolve-question";
import {questionContextSchema,type QuestionContext} from "./question-context";
import {displayedContext} from "./displayed-context";
import {RuleProvider} from "./rule-provider";
import {lastMonth} from "@/engine";
import {createViewStore,resultViewName,viewStateKey} from "@/lib/view-store";

const scenario:QuestionContext={tool:"showWhatIf",input:{period:lastMonth,category:"dining",pct:20}};
describe("bounded conversational selectors",()=>{
  it("continues a period and percentage in three languages without changing the category",async()=>{
    const provider=new RuleProvider();
    for(const [locale,month,pct] of [["en","And in September 2026?","And at 30%?"],["fi","Entä syyskuussa 2026?","Entä 30%?"],["et","Aga septembris 2026?","Aga 30%?"]] as const) {
      expect(resolveQuestion(month,scenario)).toEqual({status:"ready",tool:"showWhatIf",period:{start:"2026-09-01",end:"2026-10-01"},category:"dining",pct:20});
      const answer=await provider.answer(pct,locale,10,{context:scenario});
      const part=answer.parts.find(p=>p.type==="tool-showWhatIf");
      expect(part && "output" in part && part.output).toMatchObject({category:"dining",initialPct:30,result:{monthly:7500}});
    }
  });
  it("preserves scope for category and quoted merchant changes; independent questions start fresh",()=>{
    const prior:QuestionContext={tool:"showTransactions",input:{period:lastMonth,category:"taxi",merchant:"City taxi"}};
    expect(resolveQuestion('And at "Taxi Helsinki"?',prior)).toMatchObject({tool:"showTransactions",scope:{category:"taxi",merchant:"Taxi Helsinki"},period:lastMonth});
    expect(resolveQuestion("And coffee?",scenario)).toMatchObject({tool:"showWhatIf",category:"coffee",pct:20,period:lastMonth});
    expect(resolveQuestion("How much did I spend on taxis last month?",prior)).toMatchObject({tool:"showTransactions",scope:{category:"taxi"}});
    expect(resolveQuestion("And this week?",scenario)).toEqual({status:"clarification_required",reason:"MONTH_REQUIRED"});
    for(const q of ['And at "City taxi" last month?',"And at 101%?","And at 30.123%?","And coffee and taxis?","And not coffee?"]) expect(resolveQuestion(q,prior).status).not.toBe("ready");
    expect(resolveQuestion("And at 30%?").status).toBe("clarification_required");
  });
  it("rejects figures, unknown fields and unusable periods in client context",()=>{
    for(const input of [{...scenario.input,balance:123},{...scenario.input,rows:[]},{...scenario.input,period:{...lastMonth,amount:100}},{...scenario.input,period:{start:"2026-11-01",end:"2026-12-01"}},{...scenario.input,pct:101}]) expect(questionContextSchema.safeParse({...scenario,input}).success).toBe(false);
  });
  it("uses confirmed displayed edits, including zero; clearing the thread removes context",async()=>{
    const views=createViewStore(),answer=await new RuleProvider().answer("What if I cut dining out by 20%?","en",10);
    const part=answer.parts.find(p=>p.type==="tool-showWhatIf");if(!part || !("toolCallId" in part)) throw new Error("Missing native tool");
    const name=resultViewName(answer.id,part.toolCallId);
    views.set(viewStateKey(name,`pct:dining/${lastMonth.start}/${lastMonth.end}`),0,20);
    expect(displayedContext([answer],views)).toEqual({...scenario,input:{...scenario.input,pct:0}});
    expect(displayedContext([],views)).toBeUndefined();
    expect(displayedContext([answer,{id:"unknown",role:"assistant",parts:[{type:"text",text:"Please clarify"}]}],views)).toBeUndefined();
    expect(JSON.stringify(displayedContext([answer],views))).not.toMatch(/monthly|amount|rows|toolCallId/);
  });
});
