import {describe,it,expect} from "vitest";
import {interpretQuestion} from "./intent";

describe("fully consumed financial selectors",()=>{
  it("accepts explicit dining spelling variants without fuzzy matching source labels or extra clauses",()=>{
    const expected=interpretQuestion("What if I cut dining out by 20%?");
    expect(interpretQuestion("What if i cut dinig out by 20%?")).toEqual(expected);
    expect(interpretQuestion("What if I cut dinning out by 20%?")).toEqual(expected);
    expect(interpretQuestion('Show transactions in category "dinig out"')).toMatchObject({status:"ready",scope:{category:"dinig out"}});
    expect(interpretQuestion('Show transactions at "dinig out"')).toMatchObject({status:"ready",scope:{merchant:"dinig out"}});
    expect(interpretQuestion("What if I cut unknown dining by 20%?")).toEqual({status:"clarification_required",reason:"AMBIGUOUS_CATEGORY"});
    for(const question of ["What if I cut not dinig out by 20%?","What if I cut dinig out by -20%?","What if I cut dinig out by 20% and coffee by 50%?","What if I cut dinig out by 20.001%?"]) {
      expect(interpretQuestion(question).status,question).not.toBe("ready");
    }
  });
  it("resolves snapshot-owned months/weeks, named years and inclusive/exclusive days",()=>{
    for(const [suffix,start,end] of [
      ["last month","2026-10-01","2026-11-01"],["this month","2026-11-01","2026-11-05"],
      ["last week","2026-10-26","2026-11-02"],["this week","2026-11-02","2026-11-05"],
      ["in September 2026","2026-09-01","2026-10-01"],["in October","2026-10-01","2026-11-01"],
      ["on 2026-10-09","2026-10-09","2026-10-10"],
      ["from 2026-10-01 through 2026-10-31","2026-10-01","2026-11-01"],
      ["from 2026-10-01 until 2026-10-31","2026-10-01","2026-10-31"],
    ]) expect(interpretQuestion(`Show spending ${suffix}`)).toEqual({status:"ready",tool:"showCategories",period:{start,end}});
  });
  it("keeps merchant punctuation, wildcard symbols, escaped quotes and exact category intersection literal",()=>{
    const merchant='New %_ "Cafe" and dining';
    expect(interpretQuestion(`Show transactions in category "coffee" at ${JSON.stringify(merchant)} last month`)).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"coffee",merchant}});
    expect(interpretQuestion('Show spending at "S-market" last month')).toMatchObject({status:"ready",tool:"showTransactions",scope:{merchant:"S-market"}});
    expect(interpretQuestion('Show spending on category "new source category" last month')).toMatchObject({status:"ready",scope:{category:"new source category"}});
  });
  it("rejects unconsumed clauses, negation, multiple percentages, other currencies and invalid periods",()=>{
    for(const question of [
      "How much did I spend on taxis last year?","How much did I spend on taxis next month?",
      "How much did I spend on taxis last month and groceries this month?",
      "How much did I spend on taxis last month except weekends?",
      "What if I cut dining out by -20%?","What if I cut dining out by +20%?",
      "What if I cut dining out by 20% and coffee by 50%?","What if I cut dining out by 20.001%?",
      "What if I cut dining out by 120%?","What if I cut not dining out by 20%?",
      "Show spending on taxis in USD last month","Show spending at S-market last month",
      "Show spending from 2026-02-30 until 2026-03-01","Show spending from 2026-11-01 until 2026-11-01",
      "Show spending from 2025-01-01 until 2026-11-01","Show spending from 2026-10-01 to 2026-11-01",
      "Show spending in November 2026","Show spending on 2026-11-06",
      'Show spending at "bad\\nmerchant" last month',
    ]) expect(interpretQuestion(question).status,question).not.toBe("ready");
  });
  it("retains exact percentage precision, localized preset scope and distinct permission requests",()=>{
    expect(interpretQuestion("Reduce dining out by 20,25% last month")).toMatchObject({status:"ready",tool:"showWhatIf",category:"dining",pct:20.25});
    expect(interpretQuestion("Paljonko käytin takseihin viime viikolla?")).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"taxi"},period:{start:"2026-10-26",end:"2026-11-02"}});
    expect(interpretQuestion("Kui palju kulutasin eelmisel kuul taksole ja toidule?").status).not.toBe("ready");
    expect(interpretQuestion("What is safe for me to spend this week?")).toEqual({status:"ready",tool:"showSafeToSpend"});
    expect(interpretQuestion("What is safe for me to spend last month?").status).not.toBe("ready");
    for(const question of ["What if I cut dining out by 20% last week?","What if I cut dining out by 20% on 2026-10-09?","Compare me to others this month","Compare my taxi spending to others from 2026-09-01 until 2026-11-01"]) {
      expect(interpretQuestion(question)).toMatchObject({status:"clarification_required",reason:"MONTH_REQUIRED"});
    }
    expect(interpretQuestion("What if I cut dining out by 20% from 2026-10-01 through 2026-10-31?")).toMatchObject({status:"ready",tool:"showWhatIf",period:{start:"2026-10-01",end:"2026-11-01"}});
  });

  it("consumes localized read, reduction and comparison forms with exact category and merchant intersections",()=>{
    for(const question of ['Paljonko kulutin takseihin paikassa "Helsinki" lokakuussa?','Kui palju maksin taksole kaupmehelt "Helsinki" oktoobris?']) {
      expect(interpretQuestion(question)).toEqual({status:"ready",tool:"showTransactions",scope:{category:"taxi",merchant:"Helsinki"},period:{start:"2026-10-01",end:"2026-11-01"}});
    }
    expect(interpretQuestion("Näytä kulut kahviin viime kuussa")).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"coffee"}});
    expect(interpretQuestion("Näita kulutusi toidukaupadele eelmisel kuul")).toMatchObject({status:"ready",tool:"showTransactions",scope:{category:"groceries"}});
    for(const question of ["Mitä jos vähennän ravintolakuluja 20,25% lokakuussa?","Mis siis, kui vähendan restoranikulusid 20,25% võrra oktoobris?"]) {
      expect(interpretQuestion(question)).toMatchObject({status:"ready",tool:"showWhatIf",category:"dining",pct:20.25,period:{start:"2026-10-01",end:"2026-11-01"}});
    }
    expect(interpretQuestion("Võrdle takso kulutusi teistega oktoobris")).toMatchObject({status:"ready",tool:"showBenchmark",category:"taxi"});
    expect(interpretQuestion("Näytä kulut tässä kuussa")).toMatchObject({status:"ready",tool:"showCategories",period:{start:"2026-11-01",end:"2026-11-05"}});
    const merchant='kahvi %_ "lokakuussa" ja takso';
    expect(interpretQuestion(`Näita tehinguid kategoorias "new source category" kaupmehelt ${JSON.stringify(merchant)} oktoobris`)).toMatchObject({status:"ready",scope:{category:"new source category",merchant}});
  });

  it("keeps all localized calendar months exact and refuses unsupported localized tails or future scope",()=>{
    const languages=[
      ["Näytä kulut",["tammikuussa","helmikuussa","maaliskuussa","huhtikuussa","toukokuussa","kesäkuussa","heinäkuussa","elokuussa","syyskuussa","lokakuussa","marraskuussa","joulukuussa"]],
      ["Näita kulutusi",["jaanuaris","veebruaris","märtsis","aprillis","mais","juunis","juulis","augustis","septembris","oktoobris","novembris","detsembris"]],
    ] as const;
    for(const [prefix,months] of languages) for(const [i,month] of months.entries()) {
      const result=interpretQuestion(`${prefix} ${month} 2024`);
      expect(result).toMatchObject({status:"ready",tool:"showCategories",period:{start:`2024-${String(i+1).padStart(2,"0")}-01`,end:i===11 ? "2025-01-01" : `2024-${String(i+2).padStart(2,"0")}-01`}});
    }
    for(const question of ["Paljonko kulutin takseihin viime kuussa paitsi viikonloppuisin?","Kui palju maksin taksole eelmisel kuul ja toidule sel kuul?","Mitä jos vähennän ravintolakuluja 20% ja kahvia 50% lokakuussa?","Mis siis, kui vähendan restoranikulusid 20.001% oktoobris?","Näytä kulut marraskuussa","Näita kulutusi taksole USD oktoobris"]) {
      expect(interpretQuestion(question).status,question).not.toBe("ready");
    }
  });
});
