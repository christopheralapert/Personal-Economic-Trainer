import {describe,it,expect} from 'vitest';
import fixture from '../../../../fixtures/synthetic/amount-search.v1.json';
import {amountSelection} from './amount-search';
import {interpretQuestion,requestForIntent} from './intent';
import {transactionQuestion} from './explore-question';
import {resolveQuestion} from './resolve-question';
import {transactionPage} from '@/engine/history';
import {loadDataset} from '@/engine/datasets';
import {transactionFiltersSchema} from '@/engine';
const august={start:'2026-08-01',end:'2026-09-01'};
describe('exact EUR magnitude filters',()=>{
 for(const sample of fixture.supported)it(sample.question,()=>{
  const selected=amountSelection(sample.question);
  expect(selected).toMatchObject({present:true,valid:true,bounds:sample.bounds});
  expect(interpretQuestion(sample.question,undefined,'2026-09-30')).toMatchObject({status:'ready',tool:'showTransactions',scope:sample.bounds});
 });
 for(const question of fixture.unsupported)it(`rejects ${question}`,()=>{
  expect(amountSelection(question)).toMatchObject({present:true,valid:false});
  expect(interpretQuestion(question).status).toBe('clarification_required');
 });
 it('keeps quoted labels, localized date ranges and exact bound follow-ups intact',()=>{
  for(const locale of ['en','fi','et'] as const){
   const scope={category:'taxi',merchant:'City  Taxi',amount_min_minor:2001,amount_max_minor:3097};
   const question=transactionQuestion(august,scope,locale)!;
   const base=interpretQuestion(question,undefined,'2026-09-30');
   expect(base).toEqual({status:'ready',tool:'showTransactions',period:august,scope});
   if(base.status!=='ready')throw new Error('Expected ready');
   const request=requestForIntent(base);
   expect(resolveQuestion('What about the month before?',{tool:'showTransactions',input:request.input},august,'2026-09-30')).toMatchObject({status:'ready',scope,period:{start:'2026-07-01',end:'2026-08-01'}});
  }
 });
 it('uses all matching records for exact totals and never treats a refund as an expense',async()=>{
  const data=structuredClone(await loadDataset('organizer1')),row=data.transactions.find(r=>r.category==='taxi'&&r.booked_on.startsWith('2026-08'))!;
  data.transactions=[{...row,amount_minor:-2000},{...row,id:'00000000-0000-4000-8000-000000000001',amount_minor:-2001},
   {...row,id:'00000000-0000-4000-8000-000000000002',amount_minor:2500,economic_flow:'refund'},
   {...row,id:'00000000-0000-4000-8000-000000000003',amount_minor:-8000,status:'pending'}];
  expect(transactionPage(august,'booked',data,{category:'taxi',amount_min_minor:2001})).toMatchObject({total:2,financialCount:2,netExpenses:-499});
  expect(transactionPage(august,'booked',data,{category:'taxi',amount_min_minor:9000})).toMatchObject({total:0,netExpenses:null});
  expect(transactionFiltersSchema.safeParse({amount_min_minor:3000,amount_max_minor:2000}).success).toBe(false);
 });
});
