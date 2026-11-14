import {it,expect} from 'vitest';
import {clearGeneratedResults} from './clear-generated-results';
it('removes legacy output caches without clearing preferences, goals or imported records',()=>{
 const values=new Map([['money-coach-thread.v1.en','old figures'],['money-coach-generated.old.es','old translation'],['money-coach-preferences.v1','settings'],['saved-transactions','records']]);
 const storage={get length(){return values.size;},key:(index:number)=>[...values.keys()][index]??null,removeItem:(key:string)=>{values.delete(key);}} as Storage;
 clearGeneratedResults(storage);expect([...values.keys()]).toEqual(['money-coach-preferences.v1','saved-transactions']);
 expect(()=>clearGeneratedResults({get length():number{throw Error('denied');}} as Storage)).not.toThrow();
});
