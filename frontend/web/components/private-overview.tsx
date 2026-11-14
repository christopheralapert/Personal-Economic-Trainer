"use client";
import {useEffect,useMemo,useRef,useState} from "react";
import {useRouter} from "next/navigation";
import {ChevronLeft,ChevronRight,Wallet} from "lucide-react";
import {DonutBreakdown} from "@/components/gen/donut-breakdown";
import {Button} from "@/components/ui/button";
import {AskHome} from "@/components/ask-home";
import {Drawer,DrawerTrigger,DrawerContent,DrawerHeader,DrawerTitle,DrawerDescription,DrawerFooter,DrawerClose} from "@/components/ui/drawer";
import {CategoryIcon} from "@/components/gen/category-icon";
import {TickBar} from "@/components/gen/tick-bar";
import {categoryBreakdown} from "@/lib/category-breakdown";
import {useCopy,categoryLabel} from "@/i18n/context";
import type {components} from "@contracts";
import {useDashboard} from "./dashboard-workspace";
import {aborted,type PrivateRequest} from "./private-session";
import {date} from "@/lib/format";
import {euros,sumMinor} from "./plan-format";
import {FirstBankCard} from "./first-bank";
import {lastMonth} from "./money-tools";
type Schema=components["schemas"];
type Period=ReturnType<typeof lastMonth>;
import {reviewCopy} from "../i18n/classification-review";
import {overviewCopy as text} from "../i18n/private-overview";

export function PrivateOverview({request}:{request:PrivateRequest}) {
 const {locale,t}=useCopy(),c=text[locale],review=reviewCopy[locale],router=useRouter();
 const {data,error:accountError,loading:accountsLoading,load}=useDashboard(request);
 const allExcluded=!!data?.accounts.length&&!data.accounts.some(a=>a.included);
 const [account,setAccount]=useState("");
 const [period,setPeriod]=useState<Period>(lastMonth),[loaded,setResult]=useState<Schema["SpendingTotalsV1"]|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
 const result=loaded?.scope.start===period.start&&loaded.scope.end_exclusive===period.end_exclusive&&loaded.scope.data_version===data?.data_version?loaded:null;
 const [category,setCategory]=useState<string[]|null>(null),[entries,setEntries]=useState<Schema["LedgerPageV1"]|null>(null),[sheetError,setSheetError]=useState(false),[sheetBusy,setSheetBusy]=useState(false);const epoch=useRef(0);
 const [inventory,setInventory]=useState<Schema["LedgerInventoryV1"]|null>(null),[preview,setPreview]=useState<Schema["LedgerRowV1"][]>([]);
 const scopedAccounts=(data?.accounts??[]).filter(a=>a.included&&a.currency==="EUR"&&(!account||a.id===account));
 const observedAccounts=scopedAccounts.filter(a=>a.access_status==="observed"&&a.balance);
 const historyParams=new URLSearchParams({start:period.start,end:period.end_exclusive});if(account)historyParams.set("account_id",account);
 const recordedBalance=observedAccounts.length?sumMinor(observedAccounts.map(a=>a.balance!.amount_minor)):null;
 const balanceDate=observedAccounts.map(a=>a.balance!.observed_at).sort()[0];
 useEffect(()=>{const generation=++epoch.current;setResult(null);setInventory(null);setPreview([]);setError("");if(!data?.accounts.some(a=>a.included&&a.currency==="EUR"&&(!account||a.id===account))){setBusy(false);return;}setBusy(true);
 const q=new URLSearchParams({...period,currency:"EUR",expected_data_version:String(data.data_version)});if(account)q.set("account_id",account);
 void Promise.all([request<Schema["SpendingToolResultV1"]>("analysis/tools/execute",{name:"spending_totals",arguments:{...period,currency:"EUR",account_ids:account?[account]:null,category:null,merchant:null,expected_data_version:data.data_version}}),request<Schema["LedgerInventoryV1"]>(`ledger/inventory?${q}`),request<Schema["LedgerPageV1"]>(`ledger/transactions?${q}&status=booked&spending_only=false&limit=3`)])
 .then(([totals,records,history])=>{if(generation===epoch.current){setResult(totals.result);setInventory(records);setPreview(history.rows.slice(0,3));}}).catch(e=>{if(generation===epoch.current&&!aborted(e))setError(c.error);}).finally(()=>{if(generation===epoch.current)setBusy(false);});return()=>{epoch.current++;};},[request,data,period,retry,c.error,account]);
 const groups=useMemo(()=>{const grouped=new Map<string,{key:string;amount:number;gross:number;refunds:number;count:number}>();for(const g of result?.category_baskets??[]){const old=grouped.get(g.label)??{key:g.label,amount:0,gross:0,refunds:0,count:0};grouped.set(g.label,{key:g.label,amount:sumMinor([old.amount,g.net_minor]),gross:sumMinor([old.gross,g.gross_minor]),refunds:sumMinor([old.refunds,g.refunds_minor]),count:old.count+g.transaction_count});}return [...grouped.values()];},[result]);
 const pendingOut=inventory?.period_unreviewed_outgoing_minor??0;
 const chartGroups=useMemo(()=>{if(!pendingOut)return groups;const next=groups.map(g=>({...g})),old=next.find(g=>g.key==="unclassified"),count=inventory?.period_unreviewed_outgoing_count??0;if(old){old.amount=sumMinor([old.amount,pendingOut]);old.gross=sumMinor([old.gross,pendingOut]);old.count+=count;}else next.push({key:"unclassified",amount:pendingOut,gross:pendingOut,refunds:0,count});return next;},[groups,pendingOut,inventory?.period_unreviewed_outgoing_count]);
 const chartBreakdown=useMemo(()=>categoryBreakdown(chartGroups),[chartGroups]);
 const breakdown=useMemo(()=>categoryBreakdown(groups),[groups]),segments=chartBreakdown.segments,complete=!!result&&!result.category_breakdown_truncated&&breakdown.gross===result.gross_minor&&breakdown.net===result.net_minor;
 const baskets=["mandatory_regular","mandatory_irregular","everyday","unresolved"].map((key,i)=>({key,value:sumMinor((result?.category_baskets??[]).filter(g=>g.basket===key).map(g=>g.gross_minor)),name:[c.regular,c.surprises,c.everyday,c.unknown][i],className:["bg-brand","bg-ink","bg-ink-2","bg-line"][i]}));
 const selected=segments.find(s=>JSON.stringify(s.members.map(g=>g.key))===JSON.stringify(category));
 useEffect(()=>{let active=true;setEntries(null);setSheetError(false);if(!category||!result)return;setSheetBusy(true);const q=new URLSearchParams({...period,currency:"EUR",status:"booked",spending_only:category.includes("unclassified")&&pendingOut>0?"false":"true",limit:"50",expected_data_version:String(result.scope.data_version)});if(account)q.set("account_id",account);if(category.length===1&&!(category.includes("unclassified")&&pendingOut>0))q.set("category",category[0]);void request<Schema["LedgerPageV1"]>(`ledger/transactions?${q}`).then(v=>{if(active)setEntries(v);}).catch(e=>{if(active&&!aborted(e))setSheetError(true);}).finally(()=>{if(active)setSheetBusy(false);});return()=>{active=false;};},[category,period,result,request,pendingOut,account]);
 function move(offset:number){const d=new Date(period.start+"T12:00:00Z");d.setUTCMonth(d.getUTCMonth()+offset,1);const start=d.toISOString().slice(0,10);d.setUTCMonth(d.getUTCMonth()+1,1);setCategory(null);setPeriod({start,end_exclusive:d.toISOString().slice(0,10)});}
 const month=new Intl.DateTimeFormat(locale,{month:"long",year:"numeric",timeZone:"UTC"}).format(new Date(period.start+"T12:00:00Z"));
 if(data&&!accountsLoading&&!accountError&&data.accounts.length===0&&!data.connected_bank_count)return <FirstBankCard/>;
 return <div className="overview-flow">
  <section data-overview-block="period" className="flex items-center justify-between gap-3"><Button variant="ghost" size="icon" aria-label={c.previous} onClick={()=>move(-1)}><ChevronLeft className="size-5"/></Button><h2 className="text-sm font-semibold">{month}</h2><Button variant="ghost" size="icon" aria-label={c.next} disabled={period.start>=new Date().toISOString().slice(0,7)+"-01"} onClick={()=>move(1)}><ChevronRight className="size-5"/></Button></section>
  {data&&data.accounts.filter(a=>a.included&&a.currency==="EUR").length>1&&<label className="grid gap-1 text-sm">{t("accounts")}<select aria-label={t("accounts")} className="min-h-12 rounded-xl border border-line bg-surface px-3 text-ink" value={account} onChange={e=>{setResult(null);setInventory(null);setPreview([]);setCategory(null);setAccount(e.target.value);}}><option value="">{c.allAccounts}</option>{data.accounts.filter(a=>a.included&&a.currency==="EUR").map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>}
  <section data-overview-block="hero" className="space-y-1"><h2 className="text-sm font-normal text-ink-2">{recordedBalance!==null?c.balanceTitle:c.hero}</h2><p className="text-3xl font-bold">{recordedBalance!==null?euros(recordedBalance):c.needs}</p>{balanceDate&&<p className="text-caption text-ink-2">{c.balanceObserved.replace("{date}",date(balanceDate))} · {observedAccounts.length} {t("accounts").toLowerCase()}</p>}<p className="text-sm text-ink-2">{recordedBalance!==null?c.balanceNote:c.note}</p><Drawer><DrawerTrigger asChild><Button variant="link" size="chip">{c.why}</Button></DrawerTrigger><DrawerContent><DrawerHeader><DrawerTitle>{c.basis}</DrawerTitle><DrawerDescription>{c.basisNote}</DrawerDescription></DrawerHeader><DrawerFooter><Button asChild><a href="/plan">{c.review}</a></Button></DrawerFooter></DrawerContent></Drawer></section>
  <section data-overview-block="categories" className="space-y-2" aria-label={c.spent}>
   {(busy||accountsLoading)&&<p role="status" className="py-12 text-center text-sm text-ink-2">{t("reading")}</p>}
   {(error||accountError)&&<div role="alert" className="space-y-3 py-6"><p className="text-sm text-ink-2">{error||c.error}</p><Button variant="outline" onClick={()=>{void load();setRetry(r=>r+1);}}>{c.reload}</Button></div>}
   {!busy&&!accountsLoading&&!error&&!accountError&&!scopedAccounts.length&&<div className="flex flex-col items-center gap-3 py-8 text-center"><span className="flex size-12 items-center justify-center rounded-full bg-brand-tint text-brand"><Wallet className="size-6"/></span><h2 className="text-xl font-semibold">{allExcluded?c.needs:c.none}</h2><p className="text-sm text-ink-2">{allExcluded?c.excluded:c.empty}</p><Button asChild variant="outline"><a href={data?.connected_bank_count?"/banks":"/settings"}>{data?.connected_bank_count?c.banks:t("coachVisibility")}</a></Button></div>}
   {!busy&&!accountsLoading&&!error&&!accountError&&scopedAccounts.length>0&&inventory?.total_booked_count===0&&result?.expense_count===0&&result?.refund_count===0&&<p className="py-8 text-center text-sm text-ink-2">{c.noMonth}</p>}
   {!busy&&inventory&&inventory.period_booked_count===0&&inventory.total_booked_count>0&&<p className="py-6 text-sm text-ink-2">{c.noMonth}</p>}
   {complete&&segments.length>0&&<p className="text-caption text-ink-2">{pendingOut>0?t("unreviewedOut"):review.confirmed} · {c.entries.replace("{count}",String(result!.expense_count+(inventory?.period_unreviewed_outgoing_count??0)))}{inventory?.period_unresolved_count?` · ${inventory.period_unresolved_count} ${review.pending}`:""}</p>}
   {complete&&segments.length>0&&<DonutBreakdown compact alwaysRing netPresentation={false} groups={chartGroups} totalLabel={pendingOut>0?t("moneyOut"):undefined} onCategory={setCategory}/>}{complete&&breakdown.refunds>0&&<p className="text-caption text-ink-2">{c.refunds}: {euros(breakdown.refunds)}</p>}
   {!busy&&!accountsLoading&&inventory&&inventory.period_booked_count>0&&chartGroups.length===0&&<div className="space-y-3"><div className="space-y-1"><h2 className="text-xl font-semibold">{c.activity}</h2><p className="text-sm text-ink-2">{c.entries.replace("{count}",String(inventory.period_booked_count))} · {inventory.period_unresolved_count>0?c.classificationNote:c.partial}</p></div><ul className="divide-y divide-line">{preview.map(row=><li key={row.id} className="flex min-h-14 items-center gap-3 py-3"><CategoryIcon category="unknown" size="dense"/><div className="min-w-0 flex-1"><p className="truncate text-sm">{row.merchant}</p><p className="text-caption text-ink-2">{date(row.booked_on)}</p></div><span className={`shrink-0 text-sm font-semibold ${row.amount_minor<0?"text-neg":"text-pos"}`}>{euros(row.amount_minor)}</span></li>)}</ul><Button asChild variant="outline" className="w-full"><a href={`/transactions?${historyParams}`}>{c.more}</a></Button></div>}
   {result&&!complete&&<a className="text-sm text-brand underline" href="/analysis">{c.more}</a>}
  </section>
  <section data-overview-block="baskets" className="space-y-1">{complete&&result!.gross_minor>0&&<><TickBar parts={baskets} caption="" captionTone="ink"/><div className="flex flex-wrap gap-x-2">{baskets.filter(b=>b.value>0).map(b=><a key={b.key} href={`/learn#${b.key}`} className="flex min-h-touch items-center text-caption text-ink">{b.name} {Math.round(b.value/result!.gross_minor*100)}%</a>)}</div></>}{inventory?.period_unresolved_count ? <a className="text-sm text-brand underline" href={`/transactions?${historyParams}&needs_review=true`}>{review.review} ({inventory.period_unresolved_count})</a>:null}</section>
  <div data-overview-block="ask"><AskHome onAsk={question=>router.push(`/coach?question=${encodeURIComponent(question)}`)} busy={busy||accountsLoading}/></div>
  <Drawer open={category!==null} onOpenChange={open=>{if(!open)setCategory(null);}}><DrawerContent><DrawerHeader><DrawerTitle>{selected?.category?categoryLabel(selected.category,t):c.transactions}</DrawerTitle><DrawerDescription>{month} · {c.source} · {c.partial}</DrawerDescription></DrawerHeader><div className="max-h-sheet overflow-y-auto px-4">{sheetBusy&&<p role="status">{t("reading")}</p>}{sheetError&&<p role="alert">{c.error}</p>}<ul className="divide-y divide-line">{entries?.rows.filter(r=>(r.economic_flow==="expense"&&r.amount_minor<=0||r.economic_flow==="refund"&&r.amount_minor>=0)&&category?.includes(r.category)||category?.includes("unclassified")&&r.economic_flow==="unknown"&&r.amount_minor<0).map((r,i,rows)=><li key={r.id} className="py-2">{(i===0||r.booked_on!==rows[i-1].booked_on)&&<p className="py-2 text-caption text-ink-2">{r.booked_on}</p>}<div className="flex min-h-14 items-center gap-3"><CategoryIcon category={r.economic_flow==="unknown"?"unknown":r.category}/><span className="min-w-0 flex-1 wrap-anywhere text-sm">{r.merchant}</span><span className="text-sm font-semibold">{euros(r.amount_minor)}</span></div></li>)}</ul>{entries?.next_cursor&&<a className="flex min-h-touch items-center text-brand" href={`/transactions?${historyParams}`}>{c.more}</a>}</div><DrawerFooter><DrawerClose asChild><Button>{c.close}</Button></DrawerClose></DrawerFooter></DrawerContent></Drawer>
 </div>;
}
