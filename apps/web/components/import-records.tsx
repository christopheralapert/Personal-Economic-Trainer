"use client";

import {useEffect,useRef,useState} from "react";
import type {components} from "@contracts";
import {aborted,type PrivateRequest} from "./private-session";
import {nativeMoney} from "./import-files";

type Schema=components["schemas"];
type Filters={account:string;start:string;end:string;merchant:string;category:string;status:"booked"|"pending"|"reversed"};
const basketLabels:Record<string,string>={mandatory_regular:"Mandatory and regular",mandatory_irregular:"Mandatory and irregular",everyday:"Everyday spending",unresolved:"Basket unreviewed"};

export function ImportRecords({request,source}:{request:PrivateRequest;source:Schema["ImportPublicationViewV1"]}) {
  const [accounts,setAccounts]=useState<Schema["NativeAccountListV1"]|null>(null);
  const [filters,setFilters]=useState<Filters>({account:"",start:source.manifest.claimed_from,end:source.manifest.claimed_to_exclusive,merchant:"",category:"",status:"booked"});
  const [applied,setApplied]=useState<Filters|null>(null);
  const [page,setPage]=useState<Schema["LedgerPageV1"]|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const epoch=useRef(0),accountEpoch=useRef(0);
  useEffect(()=>{
    const generation=++accountEpoch.current;
    void request<Schema["NativeAccountListV1"]>(`imports/${source.import_id}/publication/accounts`).then(value=>{
      if (generation===accountEpoch.current) setAccounts(value);
    }).catch(reason=>{if (generation===accountEpoch.current && !aborted(reason)) setError("The source accounts could not be checked. Reload the import status before exploring records.");});
    return()=>{epoch.current++;accountEpoch.current++;};
  },[request,source.import_id]);

  const edit=(next:Partial<Filters>)=>{epoch.current++;setFilters(value=>({...value,...next}));setPage(null);setApplied(null);setError("");setBusy(false);};
  const search=async (cursor?:string)=>{
    if (cursor && !applied) return;
    if (!filters.account || !filters.start || !filters.end || filters.start>=filters.end) {setError("Choose an account and an ordered booking-date window.");return;}
    const generation=++epoch.current;setBusy(true);setPage(null);setError("");
    const chosen=cursor ? applied! : {...filters};
    const query=new URLSearchParams({account_id:chosen.account,currency:source.manifest.currency,start:chosen.start,end_exclusive:chosen.end,status:chosen.status,limit:"50"});
    if (chosen.merchant.trim()) query.set("merchant",chosen.merchant.trim());
    if (chosen.category.trim()) query.set("category",chosen.category.trim());
    if (cursor) query.set("cursor",cursor);
    try {
      const result=await request<Schema["LedgerPageV1"]>(`imports/${source.import_id}/publication/transactions?${query}`);
      if (generation!==epoch.current) return;
      setPage(result);setApplied(chosen);
    } catch (reason) {
      if (generation===epoch.current && !aborted(reason)) setError("The source, access or records changed. Check the import status, then search again; no old figures are retained here.");
    } finally {if (generation===epoch.current) setBusy(false);}
  };

  return <section className="import-subsection" aria-labelledby="import-records-heading">
    <h3 id="import-records-heading">Explore your imported entries</h3>
    <p className="field-hint">Choose an account, booking dates and your own filters. Amounts are source entries; a positive entry is not automatically income. This is a synthetic snapshot with unverified whole-finance coverage.</p>
    {error && <p className="error-notice" role="alert">{error}</p>}
    <form onSubmit={event=>{event.preventDefault();void search();}}>
      <div className="plan-fields">
        <label className="plan-field">Source account<select aria-label="Source account" required value={filters.account} disabled={!accounts?.active} onChange={event=>edit({account:event.target.value})}>
          <option value="">Choose an account</option>{accounts?.accounts.map(account=><option key={account.id} value={account.id}>{account.name} · {account.currency}</option>)}
        </select></label>
        <label className="plan-field">Entry status<select aria-label="Entry status" value={filters.status} onChange={event=>edit({status:event.target.value as Filters["status"]})}><option value="booked">Booked</option><option value="pending">Pending</option><option value="reversed">Reversed</option></select></label>
        <label className="plan-field">Booked from<input type="date" required value={filters.start} onChange={event=>edit({start:event.target.value})}/></label>
        <label className="plan-field">Booked before<input type="date" required value={filters.end} onChange={event=>edit({end:event.target.value})}/></label>
        <label className="plan-field">Merchant contains<input value={filters.merchant} maxLength={200} onChange={event=>edit({merchant:event.target.value})}/></label>
        <label className="plan-field">Category identifier<input value={filters.category} maxLength={100} placeholder="For example, coffee" onChange={event=>edit({category:event.target.value})}/></label>
      </div>
      <button className="secondary-button" disabled={busy || !accounts?.active || !filters.account}>Find source records</button>
    </form>
    {busy && <p role="status" className="field-hint">Reading your selected records…</p>}
    {page && <>
      <p className="field-hint">{page.rows.length} entry/entries on this page · {page.scope.currency} · {page.scope.start} to {page.scope.end_exclusive} (end excluded). Other currencies are not converted.</p>
      {page.rows.length===0 ? <p className="bank-empty">No entries match this query. This does not establish zero spending outside the known source window.</p> : <ul className="import-record-list">{page.rows.map(row=><li key={row.id}>
        <div><strong>{row.merchant}</strong><p className="field-hint"><time dateTime={row.booked_on}>{row.booked_on}</time> · {row.category.replaceAll("_"," ")} · {basketLabels[row.basket] ?? "Basket unreviewed"}</p>
          {row.economic_flow==="unknown" && <p className="field-hint">Economic relationship not reviewed; this entry is not classified as income or a refund.</p>}</div>
        <strong className="import-record-amount">{nativeMoney(row.amount_minor,row.currency)}</strong>
      </li>)}</ul>}
      {page.next_cursor && <button className="text-button" disabled={busy} onClick={()=>void search(page.next_cursor!)}>Next source records</button>}
    </>}
  </section>;
}
