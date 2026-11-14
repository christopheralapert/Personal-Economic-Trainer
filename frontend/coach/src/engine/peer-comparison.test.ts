import {beforeAll,describe,it,expect} from "vitest";
import {loadDataset,organizerManifest,datasetKeySchema} from "./datasets";
import {peerComparison,peerResultSchema,type PeerMetric} from "./peer-comparison";
import {spendByCategory,spendByBasket,type Dataset} from "./index";
import {scopedDataset} from "./data-scope";
import source from "../../data/cohorts.v1.json";
import {RuleProvider} from "@/coach/rule-provider";
import {createComponentTools,propsSchemas} from "@/coach/catalog";
import {hasOnlyGroundedNumbers} from "@/coach/answer-grounding";
import {money} from "@/lib/format";
import {displayedContext} from "@/coach/displayed-context";
import {createViewStore} from "@/lib/view-store";
const period={start:"2026-08-01",end:"2026-09-01"};let data:Dataset;
beforeAll(async()=>{data=await loadDataset("organizer1");});
describe("synthetic peers",()=>{
 it("reconciles category and basket numbers, cohorts and positions without subjective scores",()=>{
  for(const metric of ["taxi","dining","groceries","mandatory_regular","mandatory_irregular","everyday"] as PeerMetric[]){
   const result=peerComparison(metric,period,data);expect(peerResultSchema.safeParse(result).success).toBe(true);
   if(result.status!=="ready")throw new Error("Missing expected comparable cohort");
   const group=[...spendByCategory(period,data),...spendByBasket(period,data)].find(group=>group.key===metric);
   expect(result.you).toBe(group?.amount??0);expect(result.n).toBe(source.cells["35-44/02"].n);
   expect(result.position).toBe(result.you<result.p25 ? "below" : result.you>result.p75 ? "above" : "within");
  }
 });
 it("falls back area/age then age then all; missing history, scope and partial month have no figures",()=>{
  const reference=structuredClone(source);delete (reference.cells as Record<string,unknown>)["35-44/02"];
  expect(peerComparison("dining",period,data,reference)).toMatchObject({status:"ready",level:"age",postalPrefix:null});
  delete (reference.cells as Record<string,unknown>)["35-44"];
  expect(peerComparison("dining",period,data,reference)).toMatchObject({status:"ready",level:"all",ageBand:null});
  reference.cells={} as typeof reference.cells;
  expect(peerComparison("dining",period,data,reference)).toMatchObject({status:"insufficient",reason:"cohort"});
  for(const result of [peerComparison("dining",period,{...data,peer_context:undefined}),peerComparison("dining",period,{...data,peer_context:{...data.peer_context!,complete_months:5}}),peerComparison("dining",period,scopedDataset(data,{excludedCategories:["dining"]})),peerComparison("dining",{start:"2026-08-02",end:"2026-09-01"},data)]){expect(result.status).toBe("insufficient");expect(result).not.toHaveProperty("you");expect(result).not.toHaveProperty("median");}
 });
 it("uses grounded tools for free text in all three languages and retains peer scope on follow-up",async()=>{
  const provider=new RuleProvider();
  const questions={en:["Compare me to people like me","Am I spending more than others my age?","How does my dining compare?","How does my taxi compare?","How does my groceries compare?",'Compare my in basket "mandatory_regular" with people like me'],fi:["Vertaa minua kaltaisiini","Kulutanko enemmän kuin ikäiseni?","Miten ravintolat vertautuu ikäisiini?"],et:["Võrdle mind minusugustega","Kas kulutan rohkem kui minuvanused?","Kuidas toidukaubad teistega võrreldes on?"]};
  for(const metric of ["taxi","dining","groceries","mandatory_regular","mandatory_irregular","everyday"]){
   const basket=metric.startsWith("mandatory")||metric==="everyday";
   questions.en.push(`How does my ${basket ? `in basket "${metric}"` : metric} compare?`);
   questions.fi.push(`Vertaa ${basket ? `korissa "${metric}"` : ({taxi:"taksot",dining:"ravintolat",groceries:"ruokaostokset"} as Record<string,string>)[metric]} ikäisiini`);
   questions.et.push(`Võrdle ${basket ? `korvis "${metric}"` : ({taxi:"taksod",dining:"restoranid",groceries:"toidukaubad"} as Record<string,string>)[metric]} minuvanustega`);
  }
  for(const locale of ["en","fi","et"] as const)for(const question of questions[locale]){
   const answer=await provider.answer(question,locale,10,{data,period});const part=answer.parts.find(part=>part.type==="tool-peerComparison");
   expect(part,question).toBeDefined();if(!part || part.type!=="tool-peerComparison" || part.state!=="output-available")throw new Error("No peer tool");
   expect(hasOnlyGroundedNumbers((answer.parts[0] as {text:string}).text,part.output)).toBe(true);
   if(part.output.result.status==="ready")expect((answer.parts[0] as {text:string}).text).toContain(money(part.output.result.you));
  }
  const answer=await provider.answer("How does my dining compare?","en",10,{data,period});
  const follow=await provider.answer("What about the month before?","en",10,{data,period,context:displayedContext([answer],createViewStore())});
  expect(follow.parts.find(part=>part.type==="tool-peerComparison")).toMatchObject({input:{metric:"dining",period:{start:"2026-07-01",end:"2026-08-01"}}});
  const execute=createComponentTools(10,data).peerComparison.execute as (input:unknown,options:unknown)=>Promise<unknown>;
  const output=propsSchemas.peerComparison.parse(await execute({period,metric:"taxi"},{toolCallId:"fixture",messages:[]}));
  expect(output.result).toEqual(peerComparison("taxi",period,data));
 });
 it("keeps eight complete personas and groceries out of surprises while allowing reviewed overrides",async()=>{
  expect(Object.keys(organizerManifest)).toHaveLength(8);expect(datasetKeySchema.safeParse("organizer99").success).toBe(false);
  for(const key of Object.keys(organizerManifest)){
   const profile=await loadDataset(key);expect(profile.transactions).toHaveLength(organizerManifest[key].rows);expect(profile.as_of.slice(0,10)).toBe("2026-09-30");
   expect(profile.transactions.filter(row=>row.category==="groceries").every(row=>row.basket==="everyday")).toBe(true);
  }
  const row=data.transactions.find(row=>row.category==="groceries")!;
  const corrected=scopedDataset(data,{corrections:{[row.id]:{basket:"mandatory_irregular"}}});
  expect(corrected.transactions.find(item=>item.id===row.id)).toMatchObject({basket:"mandatory_irregular",basket_basis:"user_review",amount_minor:row.amount_minor});
 });
});
