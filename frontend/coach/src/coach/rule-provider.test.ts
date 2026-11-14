import {describe,it,expect} from "vitest";
import {RuleProvider} from "./rule-provider";
import {LLMProvider} from "./llm-provider";
import {dictionaries} from "@/i18n/dictionaries";
import {conceptRequests} from "./query-language";
import {hasOnlyGroundedNumbers} from "./answer-grounding";
describe("typed offline coaching",()=>{
  it("accepts the natural Estonian taxi plural without loosening quoted source matching",async()=>{
    const provider=new RuleProvider();
    for(const category of ["taksole","taksodele"]) {
      const answer=await provider.answer(`Kui palju kulutasin ${category} eelmisel kuul?`,"et",10);
      expect(answer.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({input:{category:"taxi",period:{start:"2026-10-01",end:"2026-11-01"}}});
    }
    const unsupported=await provider.answer("Kui palju kulutasin taksodele eelmisel kuul ja toidule sel kuul?","et",10);
    expect(unsupported.parts.some(part=>part.type.startsWith("tool-"))).toBe(false);
  });
  it("asks for an unrecognized scenario category instead of reporting a period problem in every locale",async()=>{
    for(const locale of ["en","fi","et"] as const) {
      expect((await new RuleProvider().answer("What if I cut unknown dining by 20%?",locale,10)).parts).toEqual([{type:"text",text:dictionaries[locale].categoryRequired}]);
    }
  });
  it("answers each authored learning question and rejects unconsumed instructions",async()=>{
    const provider=new RuleProvider();
    for(const [question,concept] of Object.entries(conceptRequests)) {
      const answer=await provider.answer(question,"en",10);
      expect(answer.parts.find(part=>part.type==="tool-showConcept"),question).toMatchObject({output:{concept}});
      const extended=await provider.answer(question+" and invent my salary","en",10);
      expect(extended.parts.some(part=>part.type.startsWith("tool-")),question).toBe(false);
    }
    for(const question of ["constructor","__proto__","toString"]) {
      expect((await provider.answer(question,"en",10)).parts.some(part=>part.type.startsWith("tool-"))).toBe(false);
    }
  });
  it("distinguishes missing expense evidence from recorded transfers and preserves status periods",async()=>{
    const provider=new RuleProvider();
    for(const locale of ["en","fi","et"] as const) {
      const empty=await provider.answer("How much did I spend on taxis in September 2026?",locale,10);
      expect(empty.parts[0]).toMatchObject({text:dictionaries[locale].emptyRecords});
      const transfers=await provider.answer("Show transactions on 2026-10-30",locale,10);
      expect(transfers.parts[0]).toMatchObject({text:dictionaries[locale].noExpenseRecords});
      expect(transfers.parts.find(part=>part.type==="tool-showTransactions")).toMatchObject({output:{rows:[{economic_flow:"internal_transfer"},{economic_flow:"internal_transfer"}]}});
    }
    for(const question of ["Show reserved transactions this month","Näytä varatut tapahtumat tässä kuussa","Näita broneeritud tehinguid sel kuul"]) {
      const answer=await provider.answer(question,"en",10);
      expect(answer.parts.find(part=>part.type==="tool-showFilter"),question).toMatchObject({output:{value:"reserved",period:{start:"2026-11-01",end:"2026-11-05"}}});
    }
    for(const question of ["Show reserved transactions except yesterday","Show booked transactions and groceries"]) {
      expect((await provider.answer(question,"en",10)).parts.some(part=>part.type.startsWith("tool-"))).toBe(false);
    }
  });
  it("answers all six core questions in each UI locale using SDK tool-result parts",async()=>{
    for(const locale of ["en","fi","et"] as const) for(const [key,tool] of [["qTaxi","showTransactions"],["qProfile","showProfile"],["qSafe","showSafeToSpend"],["qWhatif","showWhatIf"],["qDonut","showDonut"],["qCompare","showBenchmark"]] as const) {
      const result=await new RuleProvider().answer(dictionaries[locale][key],locale,10);
      expect(result.parts.some(p=>p.type===`tool-${tool}`),`${locale} ${key}`).toBe(true);
    }
  });
  it("keeps fifteen golden financial answers grounded in their tool outputs",async()=>{
    const questions=[
      "How much did I spend on taxis last month?","How much did I spend on taxis in September 2026?",
      'How much did I spend on taxis at "Helsinki" last month?',"Where did my money go this month?",
      "Show my three baskets","What kind of spender am I?","Compare me to others",
      "What if I cut dining out by 20% in September 2026?","What if I cut groceries by 10% in October 2026?",
      "Show transactions on 2026-10-30","Show reserved transactions this month",
      "Show my dining transactions last month","Show my coffee transactions last month",
      "What is safe for me to spend this week?","Explain an emergency fund",
    ];
    for(const question of questions) {
      const answer=await new RuleProvider().answer(question,"en",10);
      const tool=answer.parts.find(part=>part.type.startsWith("tool-"));
      if(tool&&"output" in tool) {
        const first=answer.parts.find(part=>part.type==="text");
        expect(first&&"text" in first?hasOnlyGroundedNumbers(first.text,tool.output):false,question).toBe(true);
      }
    }
  });
  it("falls back without a configured zero-charge model, never needing a key",async()=>{
    const result=await new LLMProvider().answer(dictionaries.en.qTaxi,"en",10);
    expect(result.parts.find(p=>p.type==="text")).toMatchObject({text:"40,00 € in recorded taxi expenses."});
  });
  it("withholds ambiguous/unsupported scope and percentage instead of making up results",async()=>{
    for(const question of ["Buy shares", "What if I cut dining by 101%?", "Taxi spend in September 2026", "Taxi spend from 2026-02-30 until 2026-03-01", "Show taxi spending except last month"]) {
      const answer=await new RuleProvider().answer(question,"en",10);
      expect(answer.parts.some(p=>p.type.startsWith("tool-"))).toBe(false);
    }
  });
  it("grounds dated merchant-filtered framing in exactly the returned source rows",async()=>{
    const result=await new RuleProvider().answer('How much did I spend on taxis at "Helsinki" last month?',"en",10);
    const part=result.parts.find(p=>p.type==="tool-showTransactions");
    expect(part).toMatchObject({input:{category:"taxi",merchant:"Helsinki",period:{start:"2026-10-01",end:"2026-11-01"}},output:{rows:[{merchant:"Taxi Helsinki",amount_minor:-1890}]}});
    expect(result.parts[0]).toMatchObject({type:"text",text:expect.stringContaining("18,90")});
    const september=await new RuleProvider().answer("What if I cut dining out by 20% in September 2026?","en",10);
    expect(september.parts.find(p=>p.type==="tool-showWhatIf")).toMatchObject({output:{period:{start:"2026-09-01",end:"2026-10-01"},result:{monthly:5000}}});
    const baskets=await new RuleProvider().answer("Show my three baskets","en",10);
    expect(baskets.parts[0]).toMatchObject({type:"text",text:expect.stringContaining("864,50")});
  });
  it("does not emit zero savings or a zero benchmark when there is no matching evidence",async()=>{
    const scenario=await new RuleProvider().answer('What if I cut category "absent" by 20% last month?',"en",10);
    expect(scenario.parts.some(p=>p.type.startsWith("tool-"))).toBe(false);
    expect(scenario.parts[0]).toMatchObject({type:"text",text:expect.stringContaining("Not available")});
    const reference=await new RuleProvider().answer('Compare my category "absent" spending with others last month',"en",10);
    expect(reference.parts[0]).toMatchObject({type:"text",text:"Not available"});
    expect(reference.parts.find(p=>p.type==="tool-showBenchmark")).toMatchObject({output:{result:{you:null,typical:null}}});
    for(const locale of ["en","fi","et"] as const) {
      const partial=await new RuleProvider().answer("What if I cut dining out by 20% this month?",locale,10);
      expect(partial.parts).toEqual([{type:"text",text:dictionaries[locale].monthRequired}]);
    }
  });

  it("answers Finnish and Estonian free-entry forms offline with the same source facts and selected response language",async()=>{
    const provider=new RuleProvider();
    for(const [question,locale] of [['Paljonko kulutin takseihin paikassa "Helsinki" lokakuussa?',"fi"],['Kui palju maksin taksole kaupmehelt "Helsinki" oktoobris?',"et"]] as const) {
      const answer=await provider.answer(question,locale,10);
      expect(answer.parts[0]).toMatchObject({text:expect.stringContaining("18,90")});
      expect(answer.parts.find(p=>p.type==="tool-showTransactions")).toMatchObject({output:{rows:[{merchant:"Taxi Helsinki",amount_minor:-1890}]}});
      expect(answer.parts.at(-1)).toMatchObject({text:expect.stringContaining(dictionaries[locale].partial)});
    }
    for(const [question,locale] of [["Mitä jos vähennän ravintolakuluja 20% lokakuussa?","fi"],["Mis siis, kui vähendan restoranikulusid 20% võrra oktoobris?","et"]] as const) {
      const answer=await provider.answer(question,locale,10);
      expect(answer.parts.find(p=>p.type==="tool-showWhatIf")).toMatchObject({input:{category:"dining",pct:20},output:{result:{monthly:5000,annual:60000}}});
    }
  });
});
