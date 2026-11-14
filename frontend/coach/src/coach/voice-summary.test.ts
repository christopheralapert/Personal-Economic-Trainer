import {it,expect} from 'vitest';
import {spokenAnswer} from './spoken-answer';
import {loadDataset} from '@/engine/datasets';
import {spendByCategory,simulateReduction} from '@/engine';
for(const locale of ['en','fi','et'] as const)it(`${locale}: chart speech uses exact visible category totals and changes with period`,async()=>{
 const data=await loadDataset('organizer1'),period={start:'2026-09-01',end:'2026-10-01'};
 const text=spokenAnswer('showDonut',{period},{period,groups:spendByCategory(period,data)},locale);
 for(const amount of ['7\u00a0017,40','1\u00a0390,20','884,44'])expect(text).toContain(amount);
 expect(text).toContain({en:'Home',fi:'Koti',et:'Kodu'}[locale]);expect(text).toContain('2026');expect(text).not.toMatch(/Other categories|most of/);
 const august={start:'2026-08-01',end:'2026-09-01'};
 expect(spokenAnswer('showDonut',{period:august},{period:august,groups:spendByCategory(august,data)},locale)).not.toEqual(text);
});
it('scenario speech includes the current percentage, baseline and exact saving',async()=>{
 const data=await loadDataset('organizer1'),period={start:'2026-09-01',end:'2026-10-01'};
 for(const pct of [20,30]){const result=simulateReduction('dining',pct,period,data),text=spokenAnswer('showWhatIf',{period,pct},{category:'dining',initialPct:pct,period,result},'en');expect(text).toContain(`${pct}%`);expect(text).toContain(pct===20?'159,58':'239,36');expect(text).toContain('797,88');expect(text).toContain('September 2026');}
});
