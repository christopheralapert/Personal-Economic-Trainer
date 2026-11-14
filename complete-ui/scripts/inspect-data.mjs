import {readFile} from "node:fs/promises";
const source=JSON.parse(await readFile(new URL("../data/demo.v1.json",import.meta.url),"utf8"));
const rows=source.profiles[0].transactions;
console.log(source.notice);
console.log("Columns:",Object.keys(rows[0]).join(", "));
console.log("Rows:",rows.length);
console.log("Date range:",[...rows.map(row=>row.booked_on)].sort().filter((_,i,all)=>i===0 || i===all.length-1));
console.log("Categories:",[...new Set(rows.map(row=>row.category))]);
console.log("Signed EUR minor units: expenses < 0; refunds/income > 0; internal transfers excluded from spending/income.");
