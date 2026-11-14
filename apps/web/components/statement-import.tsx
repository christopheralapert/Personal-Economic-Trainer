"use client";
import {useState} from "react";
import {useCopy} from "@/i18n/context";
import {Button} from "@/components/ui/button";
import {PrivateApiError,type PrivateRequest} from "./private-session";

const copy={
 en:{title:"Import bank statements",note:"Wise EUR CSV, up to 64 KiB. The account identity is unverified; connected Wise accounts need review. Other formats are not yet supported.",choose:"Choose CSV",preview:"Preview statement",overlap:"This period overlaps other Wise records and cannot be safely matched. Nothing was imported.",unavailable:"Statement import is not enabled here.",invalid:"Choose a valid Wise EUR CSV under 64 KiB and try again.",failed:"The import could not be confirmed. Your preview may have expired.",entries:"entries",dates:"Recorded dates",partial:"end excluded; history may be incomplete.",repeated:"Repeated references are kept as separate entries.",confirm:"Confirm import",ready:"entries available. Their purpose needs review.",view:"View transactions"},
 fi:{title:"Tuo tiliotteita",note:"Wise EUR CSV, enintään 64 KiB. Tilin henkilöllisyyttä ei ole vahvistettu; yhdistetyt Wise-tilit vaativat tarkistuksen. Muita muotoja ei vielä tueta.",choose:"Valitse CSV",preview:"Esikatsele tiliote",overlap:"Jakso on päällekkäinen muiden Wise-tietojen kanssa eikä täsmäytystä voida varmistaa. Mitään ei tuotu.",unavailable:"Tiliotteiden tuonti ei ole käytössä.",invalid:"Valitse kelvollinen Wise EUR CSV, enintään 64 KiB.",failed:"Tuontia ei voitu vahvistaa. Esikatselu on saattanut vanhentua.",entries:"tapahtumaa",dates:"Kirjatut päivät",partial:"loppupäivä ei sisälly; historia voi olla puutteellinen.",repeated:"Toistuvat viitteet säilytetään erillisinä tapahtumina.",confirm:"Vahvista tuonti",ready:"tapahtumaa käytettävissä. Tarkista niiden tarkoitus.",view:"Näytä tapahtumat"},
 et:{title:"Impordi pangaväljavõtted",note:"Wise EUR CSV, kuni 64 KiB. Konto kuuluvus pole kinnitatud; ühendatud Wise’i kontod vajavad ülevaatust. Muud vormingud pole veel toetatud.",choose:"Vali CSV",preview:"Vaata eelvaadet",overlap:"Periood kattub teiste Wise’i andmetega ja kirjeid ei saa kindlalt võrrelda. Midagi ei imporditud.",unavailable:"Väljavõtete import pole siin sisse lülitatud.",invalid:"Vali korrektne Wise’i EUR CSV suurusega kuni 64 KiB.",failed:"Importi ei saanud kinnitada. Eelvaade võis aeguda.",entries:"tehingut",dates:"Kirjete kuupäevad",partial:"lõppkuupäev ei sisaldu; ajalugu võib olla puudulik.",repeated:"Korduvate viidetega kirjed säilivad eraldi.",confirm:"Kinnita import",ready:"tehingut saadaval. Nende otstarve vajab ülevaatust.",view:"Vaata tehinguid"}
} as const;
type Preview={state:"preview";id:string;account:string;start:string;end_exclusive:string;currency:string;count:number;repeated_reference_groups:number};
type Published={state:"published";account_id:string;count:number;start:string;end_exclusive:string};
type Result=Preview|Published;
export function StatementImport({request,changed}:{request:PrivateRequest;changed:()=>void}) {
 const {locale}=useCopy(),c=copy[locale];
 const [file,setFile]=useState<File|null>(null),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 async function preview(){
  if(!file||busy)return;setBusy(true);setError("");setResult(null);
  try {if(file.size>65536)throw new Error("size");const csv=new TextDecoder("utf-8",{fatal:true}).decode(await file.arrayBuffer());const value=await request<Result>("statements/wise/preview",{csv});setFile(null);setResult(value);}
  catch(e){setError(e instanceof PrivateApiError&&e.code==="STATEMENT_OVERLAP"?c.overlap:e instanceof PrivateApiError&&e.code==="IMPORT_UNAVAILABLE"?c.unavailable:c.invalid);}
  finally{setBusy(false);}
 }
 async function confirm(){
  if(result?.state!=="preview"||busy)return;setBusy(true);setError("");
  try{const value=await request<Published>("statements/wise/confirm",{preview_id:result.id});setResult(value);changed();}
  catch(e){setError(e instanceof PrivateApiError&&e.code==="STATEMENT_OVERLAP"?c.overlap:c.failed);}
  finally{setBusy(false);}
 }
 return <section className="space-y-3 border-t border-line py-4"><h2 className="text-lg font-semibold">{c.title}</h2><p className="text-sm text-ink-2">{c.note}</p><label className="grid gap-1 text-sm">{c.choose}<input type="file" accept=".csv,text/csv" disabled={busy} onChange={e=>{setFile(e.target.files?.[0]??null);setResult(null);setError("");}}/></label><Button variant="outline" disabled={!file||busy} onClick={()=>void preview()}>{c.preview}</Button>{error&&<p role="alert" className="text-sm text-neg">{error}</p>}{result?.state==="preview"&&<div className="space-y-2" aria-live="polite"><p className="text-sm">{result.account} · {result.currency} · {result.count} {c.entries}</p><p className="text-sm text-ink-2">{c.dates}: {result.start} – {result.end_exclusive} ({c.partial})</p>{result.repeated_reference_groups>0&&<p className="text-sm text-ink-2">{c.repeated}</p>}<Button disabled={busy} onClick={()=>void confirm()}>{c.confirm}</Button></div>}{result?.state==="published"&&<div className="space-y-2" role="status"><p className="text-sm">{result.count} {c.ready}</p><Button asChild variant="outline"><a href={`/transactions?account_id=${result.account_id}&start=${result.start}&end=${result.end_exclusive}`}>{c.view}</a></Button></div>}</section>;
}
