import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
// Independently authored Finnish-context fixture. No third-party generator code or sample rows are copied.
const original=JSON.parse(await readFile(new URL("../data/demo.v1.json",import.meta.url),"utf8")).profiles[0];
const id=key=>{const value=createHash("sha256").update(`money-coach-extended-v1/${key}`).digest("hex");return `${value.slice(0,8)}-${value.slice(8,12)}-4${value.slice(13,16)}-8${value.slice(17,20)}-${value.slice(20,32)}`;};
let seed=311;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
const account=original.accounts[0].id,saving=original.accounts[1].id,transactions=[];
function add(booked_on,category,merchant,amount_minor,basket="everyday",economic_flow="expense",account_id=account){transactions.push({id:id(`${transactions.length}/${booked_on}`),account_id,amount_minor,currency:"EUR",booked_on,category,merchant,status:"booked",economic_flow,basket});}
for(let time=Date.parse("2026-05-01T12:00:00Z");time<=Date.parse("2026-11-04T12:00:00Z");time+=86400000){
 const value=new Date(time),date=value.toISOString().slice(0,10),day=value.getUTCDate(),week=value.getUTCDay(),month=value.getUTCMonth();
 add(date,"coffee","Demo cafe",-(350+Math.floor(random()*250)));
 if(week===2 || week===6)add(date,"groceries","Demo grocery",-(2600+Math.floor(random()*4200)),"mandatory_irregular");
 if(week===3 || week===5)add(date,"dining","Demo restaurant",-(1200+Math.floor(random()*2700)));
 if(week===6)add(date,"taxi","Demo taxi",-(1800+Math.floor(random()*1700)));
 if(day===6)add(date,"housing","Demo rent",-70000,"mandatory_regular");
 if(day===10)add(date,"utilities","Demo electricity",-6500,"mandatory_regular");
 if(day===12)add(date,"phone","Demo telecom",-2490,"mandatory_regular");
 if(day===16)add(date,"insurance","Demo insurance",-3500,"mandatory_regular");
 if(day===25)add(date,"salary","Demo employer",280000,"unresolved","income");
 if(day===27){add(date,"transfer","Transfer to own savings",-20000,"unresolved","internal_transfer");add(date,"transfer","Transfer from own current account",20000,"unresolved","internal_transfer",saving);}
 if(day===19 && month===6)add(date,"repairs","Demo appliance repair",-24900,"mandatory_irregular");
 if(day===20 && month===8)add(date,"repairs","Demo bicycle repair",-13800,"mandatory_irregular");
 if(day===22 && month===9)add(date,"groceries","Demo grocery refund",1290,"mandatory_irregular","refund");
}
const opening={[account]:500000,[saving]:150000},balances=original.accounts.map(a=>({account_id:a.id,amount_minor:opening[a.id]+transactions.filter(r=>r.account_id===a.id).reduce((sum,r)=>sum+r.amount_minor,0),included_credit_minor:0,observed_at:original.as_of,pending_reflection:"included"}));
const profile={name:"Independent six-month EUR demonstration",mode:"synthetic",as_of:original.as_of,accounts:original.accounts.map(({id,name,currency,included,institution_id})=>({id,name,currency,included,institution_id})),transactions,balances,bills_minor:82490,essentials_minor:45000,buffer_minor:150000};
const output={notice:"Independently authored, deterministic synthetic EUR data. Not organizer, customer or ZIP sample records. Opening funds and reserves are explicit demo assumptions; no complete real-account coverage is implied.",generator:{version:1,seed:311,start:"2026-05-01",through:"2026-11-04",opening_minor:opening},profiles:[profile]};
await writeFile(new URL("../data/extended.v1.json",import.meta.url),JSON.stringify(output,null,2)+"\n");
console.log(JSON.stringify({path:fileURLToPath(new URL("../data/extended.v1.json",import.meta.url)),rows:transactions.length,start:transactions[0].booked_on,through:transactions.at(-1).booked_on,currency:"EUR",sign:"negative expenses; positive income/refunds; paired signed internal transfers",categories:[...new Set(transactions.map(r=>r.category))],columns:Object.keys(transactions[0]),opening_minor:opening,closing_minor:balances.map(b=>b.amount_minor)},null,2));
